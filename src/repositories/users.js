// UserRepository — owns ALL reads/writes on the `users` table.
// Depends only on IDbAccessor + ICacheAccessor (DIP), never env.DB / env.KV.

import { Keys, kvGetOrLoad, ttlMs } from "./cache-policy.js";

export function normalizePlan(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "shared") return "pro"; // legacy alias
  return s === "pro" || s === "dedicated" ? s : "free";
}

export function createUserRepository({ db, cache, ctx, env }) {
  const ttl = () => ttlMs(env);
  return {
    async findById(id) {
      try {
        return await db.first(
          "SELECT id,email,name,created_at,plan,dedicated_queue,tps_override,is_admin FROM users WHERE id=?",
          [id]
        );
      } catch {
        return await db.first("SELECT id,email,name,created_at FROM users WHERE id=?", [id]);
      }
    },

    async findByEmail(email) {
      return db.first("SELECT id,email,name,created_at FROM users WHERE email=?", [email]);
    },

    async findByGoogleSub(sub) {
      return db.first("SELECT id,email,name,created_at FROM users WHERE google_sub=?", [sub]);
    },

    async create({ email, name, createdAt, googleSub = null }) {
      const res = await db.run(
        "INSERT INTO users (email,name,created_at,google_sub) VALUES (?,?,?,?)",
        [email, name, createdAt, googleSub]
      );
      return res.lastRowId;
    },

    async linkGoogleSub(userId, sub) {
      await db.run("UPDATE users SET google_sub=? WHERE id=?", [sub, userId]);
    },

    async ensureGoogleColumn() {
      try {
        const cols = await db.all("PRAGMA table_info(users)");
        const names = new Set((cols || []).map((c) => c.name));
        if (!names.has("google_sub")) await db.exec("ALTER TABLE users ADD COLUMN google_sub TEXT");
        await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)");
      } catch { /* ignore — callers fall back to email-only lookup */ }
    },

    async ensureTierColumns() {
      try {
        const cols = await db.all("PRAGMA table_info(users)");
        const names = new Set((cols || []).map((c) => c.name));
        if (!names.has("plan")) await db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
        if (!names.has("dedicated_queue")) await db.exec("ALTER TABLE users ADD COLUMN dedicated_queue TEXT");
        if (!names.has("tps_override")) await db.exec("ALTER TABLE users ADD COLUMN tps_override INTEGER");
        if (!names.has("is_admin")) await db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
      } catch { /* callers fall back to free tier */ }
    },

    // Cached owner tier for ingest routing + TPS. Short TTL so plan edits
    // propagate quickly. Returns { plan, dedicated_queue, tps_override }.
    async findTierCached(userId) {
      const t = ttl();
      return kvGetOrLoad(cache, ctx, Keys.userTier(userId), t.tier, async () => {
        try {
          await this.ensureTierColumns();
          const row = await db.first("SELECT plan,dedicated_queue,tps_override FROM users WHERE id=?", [userId]);
          if (!row) return null;
          return {
            plan: normalizePlan(row.plan),
            dedicated_queue: row.dedicated_queue || null,
            tps_override: row.tps_override != null && Number(row.tps_override) > 0
              ? Math.floor(Number(row.tps_override)) : null,
          };
        } catch {
          return null;
        }
      }, t.negative);
    },

    // Uncached tier read (used as the KV-cache loader). Bypasses KV
    // intentionally — the caller (findTierCached) caches.
    async findTierDirect(userId) {
      await this.ensureTierColumns();
      try {
        const row = await db.first("SELECT plan,dedicated_queue,tps_override FROM users WHERE id=?", [userId]);
        if (!row) return null;
        return {
          plan: normalizePlan(row.plan),
          dedicated_queue: row.dedicated_queue || null,
          tps_override: row.tps_override != null && Number(row.tps_override) > 0
            ? Math.floor(Number(row.tps_override)) : null,
        };
      } catch {
        return null;
      }
    },

    invalidateTier(userId) {
      if (userId != null) cache.del(Keys.userTier(userId), ctx);
    },

    async updatePlan(userId, { plan, dedicatedQueue, tpsOverride }) {
      await this.ensureTierColumns();
      await db.run("UPDATE users SET plan=?, dedicated_queue=?, tps_override=? WHERE id=?",
        [plan, dedicatedQueue, tpsOverride, userId]);
      this.invalidateTier(userId);
    },

    // Self-serve plan switch (free <-> pro): touches the plan column only,
    // leaving dedicated_queue / tps_override intact for admins.
    async updatePlanOnly(userId, plan) {
      await this.ensureTierColumns();
      await db.run("UPDATE users SET plan=? WHERE id=?", [plan, userId]);
      this.invalidateTier(userId);
    },
  };
}
