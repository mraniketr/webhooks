// CounterRepository — owns ALL reads/writes on `subscription_counters` and
// `subscription_daily_counters`. The ONLY aggregate writer path (analytics
// queue) funnels through processMessages().

import { dayOf, now } from "../processing.js";

const ANALYTICS_FIELDS = new Set(["enqueued", "delivered_ok", "delivered_failed"]);

export function createCounterRepository({ db }) {
  const repo = {
    // Queue entry point: collapse N messages into one UPSERT per
    // (subscription, day), so hot-path throughput never becomes per-event
    // D1 writes. Invalid rows are skipped (fail-open).
    async processMessages(messages) {
      await repo.ensureTables();
      const subAcc = new Map();
      for (const m of messages || []) {
        const b = m.body || m || {};
        const webhookId = Number(b.webhookId);
        const subscriptionId = b.subscriptionId != null ? Number(b.subscriptionId) : 0;
        if (!webhookId || !subscriptionId || !ANALYTICS_FIELDS.has(b.field)) continue;
        const day = String(b.day || dayOf(now()));
        const count = Math.max(1, Math.min(10000, Number(b.count) || 1));
        const key = `${subscriptionId}|${day}`;
        if (!subAcc.has(key)) {
          subAcc.set(key, { subscriptionId, webhookId, day, enqueued: 0, delivered_ok: 0, delivered_failed: 0 });
        }
        subAcc.get(key)[b.field] += count;
      }
      if (subAcc.size) await repo.upsertBatch([...subAcc.values()]);
    },
    async ensureTables() {
      try {
        await db.exec(`CREATE TABLE IF NOT EXISTS subscription_counters (
          subscription_id INTEGER PRIMARY KEY, webhook_id INTEGER NOT NULL,
          enqueued INTEGER NOT NULL DEFAULT 0, delivered_ok INTEGER NOT NULL DEFAULT 0,
          delivered_failed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
          FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
          FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
        )`);
        await db.exec(`CREATE TABLE IF NOT EXISTS subscription_daily_counters (
          subscription_id INTEGER NOT NULL, day TEXT NOT NULL,
          enqueued INTEGER NOT NULL DEFAULT 0, delivered_ok INTEGER NOT NULL DEFAULT 0,
          delivered_failed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
          PRIMARY KEY (subscription_id, day),
          FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
        )`);
      } catch { /* next batch retries */ }
    },

    async seed(subscriptionId, webhookId) {
      try {
        await db.run(
          "INSERT OR IGNORE INTO subscription_counters (subscription_id, webhook_id, enqueued, delivered_ok, delivered_failed, updated_at) VALUES (?,?,?,?,?,?)",
          [subscriptionId, webhookId, 0, 0, 0, new Date().toISOString()]);
      } catch { /* ignore */ }
    },

    async deleteForSubscription(subscriptionId) {
      try {
        await db.run("DELETE FROM subscription_counters WHERE subscription_id=?", [subscriptionId]);
        await db.run("DELETE FROM subscription_daily_counters WHERE subscription_id=?", [subscriptionId]);
      } catch { /* ignore */ }
    },

    async deleteForWebhook(webhookId) {
      try {
        await db.run("DELETE FROM subscription_counters WHERE webhook_id=?", [webhookId]);
        await db.run("DELETE FROM subscription_daily_counters WHERE subscription_id NOT IN (SELECT id FROM subscriptions)", []);
      } catch { /* ignore */ }
    },

    // Collapse N analytics messages into one UPSERT per (subscription, day).
    async upsertBatch(entries) {
      await this.ensureTables();
      const ts = new Date().toISOString();
      for (const e of entries) {
        await db.run(
          `INSERT INTO subscription_counters (subscription_id, webhook_id, enqueued, delivered_ok, delivered_failed, updated_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(subscription_id) DO UPDATE SET
             enqueued=enqueued+excluded.enqueued, delivered_ok=delivered_ok+excluded.delivered_ok,
             delivered_failed=delivered_failed+excluded.delivered_failed, updated_at=excluded.updated_at`,
          [e.subscriptionId, e.webhookId, e.enqueued, e.delivered_ok, e.delivered_failed, ts]);
        await db.run(
          `INSERT INTO subscription_daily_counters (subscription_id, day, enqueued, delivered_ok, delivered_failed, updated_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(subscription_id, day) DO UPDATE SET
             enqueued=enqueued+excluded.enqueued, delivered_ok=delivered_ok+excluded.delivered_ok,
             delivered_failed=delivered_failed+excluded.delivered_failed, updated_at=excluded.updated_at`,
          [e.subscriptionId, e.day, e.enqueued, e.delivered_ok, e.delivered_failed, ts]);
      }
    },

    async findWithSubscription(subscriptionId) {
      await this.ensureTables().catch(() => {});
      return db.first(
        `SELECT s.*, CASE WHEN s.secret IS NOT NULL AND s.secret != '' THEN 1 ELSE 0 END AS has_secret,
         COALESCE(c.enqueued,0) enqueued, COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
         FROM subscriptions s LEFT JOIN subscription_counters c ON c.subscription_id=s.id WHERE s.id=?`,
        [subscriptionId]).catch(() => null);
    },

    async findDaily(subscriptionId, limit = 30) {
      return db.all(
        `SELECT day,enqueued,delivered_ok,delivered_failed,updated_at
         FROM subscription_daily_counters WHERE subscription_id=? ORDER BY day DESC LIMIT ${Math.max(1, Math.min(90, limit))}`,
        [subscriptionId]).catch(() => []);
    },

    async listByWebhookWithCounters(webhookId) {
      await this.ensureTables().catch(() => {});
      await this.ensureSubscriptionColumnsFallback();
      try {
        return await db.all(
          `SELECT s.id,s.name,s.target_url,s.enabled,s.created_at,s.http_method,s.headers_json,s.payload_mode,s.payload_template,s.filter_code,
           CASE WHEN s.secret IS NOT NULL AND s.secret != '' THEN 1 ELSE 0 END AS has_secret,
           COALESCE(c.enqueued,0) enqueued, COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
           FROM subscriptions s LEFT JOIN subscription_counters c ON c.subscription_id=s.id
           WHERE s.webhook_id=? ORDER BY s.id`, [webhookId]);
      } catch {
        try {
          return await db.all(
            `SELECT s.id,s.name,s.target_url,s.enabled,s.created_at,s.http_method,s.headers_json,s.payload_mode,s.payload_template,
             CASE WHEN s.secret IS NOT NULL AND s.secret != '' THEN 1 ELSE 0 END AS has_secret,
             COALESCE(c.enqueued,0) enqueued, COALESCE(c.delivered_ok,0) delivered_ok, COALESCE(c.delivered_failed,0) delivered_failed
             FROM subscriptions s LEFT JOIN subscription_counters c ON c.subscription_id=s.id
             WHERE s.webhook_id=? ORDER BY s.id`, [webhookId]);
        } catch {
          try {
            return await db.all(
              `SELECT id,name,target_url,enabled,created_at,http_method,headers_json,payload_mode,payload_template,
               CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
               FROM subscriptions WHERE webhook_id=? ORDER BY id`, [webhookId]);
          } catch {
            return await db.all(
              `SELECT id,name,target_url,enabled,created_at,
               CASE WHEN secret IS NOT NULL AND secret != '' THEN 1 ELSE 0 END AS has_secret
               FROM subscriptions WHERE webhook_id=? ORDER BY id`, [webhookId]);
          }
        }
      }
    },

    // Kept here (not in subscriptions.js) so the fallback-column ladder for
    // the counters JOIN lives next to the counters tables it joins.
    async ensureSubscriptionColumnsFallback() {
      try {
        const cols = await db.all("PRAGMA table_info(subscriptions)");
        const names = new Set((cols || []).map((c) => c.name));
        if (!names.has("http_method")) await db.exec("ALTER TABLE subscriptions ADD COLUMN http_method TEXT DEFAULT 'POST'");
        if (!names.has("headers_json")) await db.exec("ALTER TABLE subscriptions ADD COLUMN headers_json TEXT");
        if (!names.has("payload_mode")) await db.exec("ALTER TABLE subscriptions ADD COLUMN payload_mode TEXT DEFAULT 'passthrough'");
        if (!names.has("payload_template")) await db.exec("ALTER TABLE subscriptions ADD COLUMN payload_template TEXT");
        if (!names.has("filter_code")) await db.exec("ALTER TABLE subscriptions ADD COLUMN filter_code TEXT");
      } catch { /* ignore */ }
    },
  };
  return repo;
}
