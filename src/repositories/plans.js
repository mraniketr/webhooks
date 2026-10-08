// PlanRepository — owns ALL reads/writes on the `plans` table + the
// effective-limit math (previously scattered across index.js).

import { Keys, kvGetOrLoad, ttlMs } from "./cache-policy.js";
import { normalizePlan } from "./users.js";

export const VALID_PLANS = new Set(["free", "pro", "dedicated"]);

export const FALLBACK_PLAN_LIMITS = {
  free: { tps_limit: 60, burst_limit: 120, window_seconds: 60, daily_limit: 1000, max_webhooks: 2, max_subs_per_webhook: 3, price_cents: 0, price_display: "$0", infra: "shared", description: "Shared infra · for trying things out" },
  pro: { tps_limit: 6000, burst_limit: 12000, window_seconds: 60, daily_limit: 10000, max_webhooks: 10, max_subs_per_webhook: 10, price_cents: 1900, price_display: "$19/mo", infra: "shared", description: "Shared infra · higher throughput" },
  dedicated: { tps_limit: 100000, burst_limit: 200000, window_seconds: 60, daily_limit: null, max_webhooks: null, max_subs_per_webhook: null, price_cents: 0, price_display: "Custom", infra: "dedicated", description: "Dedicated queue + database · custom limits" },
};

export function structuredFallbackPlans() {
  return JSON.parse(JSON.stringify(FALLBACK_PLAN_LIMITS));
}

export function effectiveTierLimit(planCfg, tierRow) {
  const cfg = planCfg?.[tierRow.plan] || FALLBACK_PLAN_LIMITS[tierRow.plan] || FALLBACK_PLAN_LIMITS.free;
  const override = tierRow.tps_override != null && Number(tierRow.tps_override) > 0
    ? Math.floor(Number(tierRow.tps_override)) : null;
  return {
    tps_limit: override || cfg.tps_limit,
    burst_limit: Math.max(override || cfg.tps_limit, cfg.burst_limit),
    window_seconds: cfg.window_seconds,
    daily_limit: cfg.daily_limit ?? null,
    max_webhooks: cfg.max_webhooks ?? null,
    max_subs_per_webhook: cfg.max_subs_per_webhook ?? null,
    price_cents: cfg.price_cents ?? 0,
    price_display: cfg.price_display ?? "$0",
    infra: cfg.infra || "shared",
    description: cfg.description ?? null,
    overridden: override != null,
  };
}

export function createPlanRepository({ db, cache, ctx, env }) {
  const ttl = () => ttlMs(env);
  const repo = {
    async ensureTable() {
      try {
        await db.exec(`CREATE TABLE IF NOT EXISTS plans (
          plan TEXT PRIMARY KEY CHECK(plan IN ('free','shared','dedicated','pro')),
          tps_limit INTEGER NOT NULL, burst_limit INTEGER NOT NULL,
          window_seconds INTEGER NOT NULL DEFAULT 60, daily_limit INTEGER,
          max_webhooks INTEGER, max_subs_per_webhook INTEGER,
          price_cents INTEGER NOT NULL DEFAULT 0, price_display TEXT NOT NULL DEFAULT '$0',
          infra TEXT NOT NULL DEFAULT 'shared', description TEXT, updated_at TEXT NOT NULL
        )`);
        try {
          const cols = await db.all("PRAGMA table_info(plans)");
          const names = new Set((cols || []).map((c) => c.name));
          if (!names.has("daily_limit")) await db.exec("ALTER TABLE plans ADD COLUMN daily_limit INTEGER");
          if (!names.has("max_webhooks")) await db.exec("ALTER TABLE plans ADD COLUMN max_webhooks INTEGER");
          if (!names.has("max_subs_per_webhook")) await db.exec("ALTER TABLE plans ADD COLUMN max_subs_per_webhook INTEGER");
          if (!names.has("price_cents")) await db.exec("ALTER TABLE plans ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0");
          if (!names.has("price_display")) await db.exec("ALTER TABLE plans ADD COLUMN price_display TEXT NOT NULL DEFAULT '$0'");
          if (!names.has("infra")) await db.exec("ALTER TABLE plans ADD COLUMN infra TEXT NOT NULL DEFAULT 'shared'");
          if (!names.has("description")) await db.exec("ALTER TABLE plans ADD COLUMN description TEXT");
        } catch { /* old SQLite — loader falls back per-row */ }
        const ts = new Date().toISOString();
        const fb = FALLBACK_PLAN_LIMITS;
        await db.batch([
          { sql: `INSERT OR IGNORE INTO plans (plan,tps_limit,burst_limit,window_seconds,daily_limit,max_webhooks,max_subs_per_webhook,price_cents,price_display,infra,description,updated_at) VALUES ('free',?,?,?,?,?,?,?,?,?,?,?)`,
            params: [fb.free.tps_limit, fb.free.burst_limit, fb.free.window_seconds, fb.free.daily_limit, fb.free.max_webhooks, fb.free.max_subs_per_webhook, fb.free.price_cents, fb.free.price_display, fb.free.infra, fb.free.description, ts] },
          { sql: `INSERT OR IGNORE INTO plans (plan,tps_limit,burst_limit,window_seconds,daily_limit,max_webhooks,max_subs_per_webhook,price_cents,price_display,infra,description,updated_at) VALUES ('pro',?,?,?,?,?,?,?,?,?,?,?)`,
            params: [fb.pro.tps_limit, fb.pro.burst_limit, fb.pro.window_seconds, fb.pro.daily_limit, fb.pro.max_webhooks, fb.pro.max_subs_per_webhook, fb.pro.price_cents, fb.pro.price_display, fb.pro.infra, fb.pro.description, ts] },
          { sql: `INSERT OR IGNORE INTO plans (plan,tps_limit,burst_limit,window_seconds,daily_limit,max_webhooks,max_subs_per_webhook,price_cents,price_display,infra,description,updated_at) VALUES ('dedicated',?,?,?,?,?,?,?,?,?,?,?)`,
            params: [fb.dedicated.tps_limit, fb.dedicated.burst_limit, fb.dedicated.window_seconds, fb.dedicated.daily_limit, fb.dedicated.max_webhooks, fb.dedicated.max_subs_per_webhook, fb.dedicated.price_cents, fb.dedicated.price_display, fb.dedicated.infra, fb.dedicated.description, ts] },
        ]);
        try {
          const shared = await db.first("SELECT * FROM plans WHERE plan='shared'");
          if (shared) {
            const pro = await db.first("SELECT * FROM plans WHERE plan='pro'").catch(() => null);
            if (!pro) await db.run("UPDATE plans SET plan='pro' WHERE plan='shared'").catch(() => {});
            else await db.run("DELETE FROM plans WHERE plan='shared'").catch(() => {});
            await db.run("UPDATE users SET plan='pro' WHERE plan='shared'").catch(() => {});
          }
        } catch { /* ignore */ }
      } catch { /* callers fall back to defaults */ }
    },

    // KV-cached full plan map. Loader falls back to compiled defaults when
    // D1 is unreachable / pre-migration.
    async getAllCached() {
      const t = ttl();
      return kvGetOrLoad(cache, ctx, Keys.PLANS, t.plans, async () => this.loadAll());
    },

    async loadAll() {
      await this.ensureTable();
      try {
        const rows = await db.all("SELECT * FROM plans");
        const out = {};
        for (const r of rows || []) {
          const plan = normalizePlan(r.plan);
          if (!FALLBACK_PLAN_LIMITS[plan]) continue;
          const fb = FALLBACK_PLAN_LIMITS[plan];
          const quotaOrFallback = (v, fallback) => {
            if (v === null || v === undefined) return v === null ? null : fallback;
            if (v === "") return fallback;
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            if (n <= 0) return null;
            return Math.floor(n);
          };
          out[plan] = {
            tps_limit: Math.max(1, Number(r.tps_limit) || fb.tps_limit),
            burst_limit: Math.max(1, Number(r.burst_limit) || fb.burst_limit),
            window_seconds: Math.min(3600, Math.max(1, Number(r.window_seconds) || 60)),
            daily_limit: quotaOrFallback(r.daily_limit, fb.daily_limit),
            max_webhooks: quotaOrFallback(r.max_webhooks, fb.max_webhooks),
            max_subs_per_webhook: quotaOrFallback(r.max_subs_per_webhook, fb.max_subs_per_webhook),
            price_cents: Number(r.price_cents ?? fb.price_cents) || 0,
            price_display: r.price_display ?? fb.price_display,
            infra: r.infra || fb.infra,
            description: r.description ?? fb.description ?? null,
          };
        }
        return { ...structuredFallbackPlans(), ...out };
      } catch {
        return structuredFallbackPlans();
      }
    },

    async findByPlan(plan) {
      await this.ensureTable().catch(() => {});
      return db.first("SELECT * FROM plans WHERE plan=?", [plan]).catch(() => null);
    },

    async update(plan, next) {
      await this.ensureTable();
      await db.run(
        `UPDATE plans SET tps_limit=?, burst_limit=?, window_seconds=?, daily_limit=?,
         max_webhooks=?, max_subs_per_webhook=?, price_cents=?, price_display=?, infra=?, description=?, updated_at=? WHERE plan=?`,
        [next.tps_limit, next.burst_limit, next.window_seconds, next.daily_limit,
         next.max_webhooks, next.max_subs_per_webhook, next.price_cents, next.price_display,
         next.infra, next.description, new Date().toISOString(), plan]);
      this.invalidate();
    },

    invalidate() {
      cache.del(Keys.PLANS, ctx);
    },
  };
  return repo;
}
