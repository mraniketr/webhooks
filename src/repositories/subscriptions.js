// SubscriptionRepository — owns ALL reads/writes on `subscriptions`.
// Single-row hot path (delivery worker) is KV-cached; bulk fan-out shapes
// stay uncached and are assembled by routes.js.

import { Keys, kvGetOrLoad, ttlMs } from "./cache-policy.js";

export function createSubscriptionRepository({ db, cache, ctx, env }) {
  const ttl = () => ttlMs(env);
  const repo = {
    async ensureColumns() {
      try {
        const cols = await db.all("PRAGMA table_info(subscriptions)");
        const names = new Set((cols || []).map((c) => c.name));
        if (!names.has("http_method")) await db.exec("ALTER TABLE subscriptions ADD COLUMN http_method TEXT DEFAULT 'POST'");
        if (!names.has("headers_json")) await db.exec("ALTER TABLE subscriptions ADD COLUMN headers_json TEXT");
        if (!names.has("payload_mode")) await db.exec("ALTER TABLE subscriptions ADD COLUMN payload_mode TEXT DEFAULT 'passthrough'");
        if (!names.has("payload_template")) await db.exec("ALTER TABLE subscriptions ADD COLUMN payload_template TEXT");
        if (!names.has("filter_code")) await db.exec("ALTER TABLE subscriptions ADD COLUMN filter_code TEXT");
      } catch { /* callers fall back */ }
    },

    // Delivery hot path: cached single row, concurrent with webhook row.
    async findByIdCached(subscriptionId) {
      const t = ttl();
      return kvGetOrLoad(cache, ctx, Keys.subscription(subscriptionId), t.subscription, async () =>
        db.first("SELECT * FROM subscriptions WHERE id=?", [subscriptionId]),
        t.negative);
    },

    // Uncached re-check for the stale-disabled guard (delivery worker): a
    // cached disabled/missing row must never drop a delivery right after a
    // re-enable. Bypasses KV intentionally.
    async findByIdDirect(subscriptionId) {
      return db.first("SELECT * FROM subscriptions WHERE id=?", [subscriptionId]).catch(() => null);
    },

    // Router fan-out shape: enabled ids + per-sub filter codes.
    async listEnabledForFanout(webhookId) {
      await this.ensureColumns().catch(() => {});
      try {
        const rows = await db.all(
          "SELECT id,filter_code FROM subscriptions WHERE webhook_id=? AND enabled=1 ORDER BY id",
          [webhookId]);
        return rows.map((s) => ({ id: Number(s.id), filter_code: s.filter_code ?? null })).filter((s) => Boolean(s.id));
      } catch {
        const rows = await db.all(
          "SELECT id FROM subscriptions WHERE webhook_id=? AND enabled=1 ORDER BY id",
          [webhookId]).catch(() => []);
        return rows.map((s) => ({ id: Number(s.id), filter_code: null })).filter((s) => Boolean(s.id));
      }
    },

    async countByWebhook(webhookId) {
      try {
        const row = await db.first("SELECT COUNT(*) AS n FROM subscriptions WHERE webhook_id=?", [webhookId]);
        return Number(row?.n ?? 0);
      } catch {
        return 0;
      }
    },

    async listAllByWebhook(webhookId) {
      return db.all("SELECT * FROM subscriptions WHERE webhook_id=?", [webhookId]);
    },

    // Full replace (create-webhook flow): delete + re-insert + seed counters.
    async replaceAll(webhookId, subs, { seedCounters } = {}) {
      await this.ensureColumns();
      await db.run("DELETE FROM subscriptions WHERE webhook_id=?", [webhookId]);
      const createdAt = new Date().toISOString();
      for (const s of subs) {
        let subId = 0;
        try {
          const r = await db.run(
            "INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,filter_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [webhookId, s.name, s.target_url, s.secret, s.enabled, s.http_method || "POST",
             s.headers_json || null, s.payload_mode || "passthrough", s.payload_template || null,
             s.filter_code || null, createdAt]);
          subId = r.lastRowId;
        } catch {
          try {
            const r = await db.run(
              "INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
              [webhookId, s.name, s.target_url, s.secret, s.enabled, s.http_method || "POST",
               s.headers_json || null, s.payload_mode || "passthrough", s.payload_template || null, createdAt]);
            subId = r.lastRowId;
          } catch {
            const r = await db.run(
              "INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,created_at) VALUES (?,?,?,?,?,?)",
              [webhookId, s.name, s.target_url, s.secret, s.enabled, createdAt]);
            subId = r.lastRowId;
          }
        }
        if (subId && seedCounters) await seedCounters(subId, webhookId).catch(() => {});
      }
    },

    // In-place merge (update-webhook flow): preserves secrets + counters.
    async merge(webhookId, input, { seedCounters, deleteCounters } = {}) {
      await this.ensureColumns();
      const current = await db.all("SELECT * FROM subscriptions WHERE webhook_id=?", [webhookId]);
      const byId = new Map(current.map((s) => [s.id, s]));
      const seen = new Set();
      const createdAt = new Date().toISOString();
      for (const item of input) {
        const id = Number(item.id);
        if (id && byId.has(id)) {
          seen.add(id);
          const prev = byId.get(id);
          const nextFilter = item.filter_code !== undefined && item.filter_code !== null
            ? item.filter_code : (prev.filter_code ?? null);
          try {
            await db.run(
              "UPDATE subscriptions SET name=?, target_url=?, secret=?, enabled=?, http_method=?, headers_json=?, payload_mode=?, payload_template=?, filter_code=? WHERE id=?",
              [item.name, item.target_url, item.secret ? item.secret : prev.secret, item.enabled,
               item.http_method || prev.http_method || "POST", item.headers_json ?? prev.headers_json,
               item.payload_mode || prev.payload_mode || "passthrough",
               item.payload_mode === "custom" ? (item.payload_template || null) : null,
               nextFilter || null, id]);
          } catch {
            try {
              await db.run(
                "UPDATE subscriptions SET name=?, target_url=?, secret=?, enabled=?, http_method=?, headers_json=?, payload_mode=?, payload_template=? WHERE id=?",
                [item.name, item.target_url, item.secret ? item.secret : prev.secret, item.enabled,
                 item.http_method || prev.http_method || "POST", item.headers_json ?? prev.headers_json,
                 item.payload_mode || prev.payload_mode || "passthrough",
                 item.payload_mode === "custom" ? (item.payload_template || null) : null, id]);
            } catch {
              await db.run("UPDATE subscriptions SET name=?, target_url=?, secret=?, enabled=? WHERE id=?",
                [item.name, item.target_url, item.secret ? item.secret : prev.secret, item.enabled, id]);
            }
          }
        } else {
          let newId = 0;
          try {
            const r = await db.run(
              "INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,filter_code,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
              [webhookId, item.name, item.target_url, item.secret || null, item.enabled,
               item.http_method || "POST", item.headers_json || null, item.payload_mode || "passthrough",
               item.payload_mode === "custom" ? (item.payload_template || null) : null,
               item.filter_code || null, createdAt]);
            newId = r.lastRowId;
          } catch {
            try {
              const r = await db.run(
                "INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,http_method,headers_json,payload_mode,payload_template,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [webhookId, item.name, item.target_url, item.secret || null, item.enabled,
                 item.http_method || "POST", item.headers_json || null, item.payload_mode || "passthrough",
                 item.payload_mode === "custom" ? (item.payload_template || null) : null, createdAt]);
              newId = r.lastRowId;
            } catch {
              const r = await db.run(
                "INSERT INTO subscriptions (webhook_id,name,target_url,secret,enabled,created_at) VALUES (?,?,?,?,?,?)",
                [webhookId, item.name, item.target_url, item.secret || null, item.enabled, createdAt]);
              newId = r.lastRowId;
            }
          }
          if (newId && seedCounters) await seedCounters(newId, webhookId).catch(() => {});
        }
      }
      for (const s of current) {
        if (!seen.has(s.id)) {
          await db.run("DELETE FROM subscriptions WHERE id=?", [s.id]);
          if (deleteCounters) await deleteCounters(s.id).catch(() => {});
          this.invalidate(s.id);
        }
      }
    },

    invalidate(subscriptionId) {
      if (subscriptionId != null) cache.del(Keys.subscription(subscriptionId), ctx);
    },
  };
  return repo;
}
