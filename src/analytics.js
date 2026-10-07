import { dayOf, now } from "./processing.js";

// Analytics writer — the ONLY aggregate counter writer in the system.
// Owned by the router worker (which also consumes the analytics queue),
// but kept in this separate file so queue consumers never mix.
//
// Batches collapse N messages into one UPSERT per (subscription, day), so
// hot-path throughput never translates into per-event D1 writes. All stats
// are subscription-level.

const ANALYTICS_FIELDS = new Set(["enqueued", "delivered_ok", "delivered_failed"]);

async function processAnalyticsBatch(messages, env) {
  await ensureSubscriptionCounterTables(env);
  // Accumulate {"subId|day" -> {subscriptionId, webhookId, day, counts}}
  const subAcc = new Map();
  for (const m of messages) {
    const b = m.body || {};
    const webhookId = Number(b.webhookId);
    const subscriptionId = b.subscriptionId != null ? Number(b.subscriptionId) : 0;
    if (!webhookId || !subscriptionId || !ANALYTICS_FIELDS.has(b.field)) continue;
    const day = String(b.day || dayOf(now()));
    const count = Math.max(1, Math.min(10000, Number(b.count) || 1));
    const key = `${subscriptionId}|${day}`;
    if (!subAcc.has(key)) subAcc.set(key, { subscriptionId, webhookId, day, enqueued: 0, delivered_ok: 0, delivered_failed: 0 });
    subAcc.get(key)[b.field] += count;
  }
  const ts = now();
  for (const entry of subAcc.values()) {
    await env.DB.prepare(
      `INSERT INTO subscription_counters (subscription_id, webhook_id, enqueued, delivered_ok, delivered_failed, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(subscription_id) DO UPDATE SET
         enqueued=enqueued+excluded.enqueued,
         delivered_ok=delivered_ok+excluded.delivered_ok,
         delivered_failed=delivered_failed+excluded.delivered_failed,
         updated_at=excluded.updated_at`
    ).bind(entry.subscriptionId, entry.webhookId, entry.enqueued, entry.delivered_ok, entry.delivered_failed, ts).run();
    await env.DB.prepare(
      `INSERT INTO subscription_daily_counters (subscription_id, day, enqueued, delivered_ok, delivered_failed, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(subscription_id, day) DO UPDATE SET
         enqueued=enqueued+excluded.enqueued,
         delivered_ok=delivered_ok+excluded.delivered_ok,
         delivered_failed=delivered_failed+excluded.delivered_failed,
         updated_at=excluded.updated_at`
    ).bind(entry.subscriptionId, entry.day, entry.enqueued, entry.delivered_ok, entry.delivered_failed, ts).run();
  }
}

async function ensureSubscriptionCounterTables(env) {
  // Best-effort auto-migration for DBs created before subscription counters.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscription_counters (
      subscription_id INTEGER PRIMARY KEY,
      webhook_id INTEGER NOT NULL,
      enqueued INTEGER NOT NULL DEFAULT 0,
      delivered_ok INTEGER NOT NULL DEFAULT 0,
      delivered_failed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
      FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS subscription_daily_counters (
      subscription_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      enqueued INTEGER NOT NULL DEFAULT 0,
      delivered_ok INTEGER NOT NULL DEFAULT 0,
      delivered_failed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subscription_id, day),
      FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
    )`).run();
  } catch { /* ignore — next batch retries */ }
}

async function processAnalytics(message, env, ctx) {
  await processAnalyticsBatch([{ body: message }], env);
}

export { processAnalytics, processAnalyticsBatch };
