-- Migration: subscription-level delivery stats.
-- Previously delivered_ok / delivered_failed were only tracked per webhook
-- in webhook_counters. Delivery outcomes now accumulate per subscription.
-- received/processed stay webhook-level (ingest + pre-action fan-out).
-- Apply with:
--   npx wrangler d1 execute hooklane-db --remote --file=./migrate-subscription-counters.sql

CREATE TABLE IF NOT EXISTS subscription_counters (
  subscription_id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL,
  enqueued INTEGER NOT NULL DEFAULT 0,
  delivered_ok INTEGER NOT NULL DEFAULT 0,
  delivered_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_daily_counters (
  subscription_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  enqueued INTEGER NOT NULL DEFAULT 0,
  delivered_ok INTEGER NOT NULL DEFAULT 0,
  delivered_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, day),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_counters_webhook ON subscription_counters(webhook_id);
CREATE INDEX IF NOT EXISTS idx_sub_daily_day ON subscription_daily_counters(day);

-- Backfill: seed one zeroed row per existing subscription so JOINs return
-- rows immediately (counters stay 0 until new deliveries land).
INSERT OR IGNORE INTO subscription_counters (subscription_id, webhook_id, enqueued, delivered_ok, delivered_failed, updated_at)
SELECT id, webhook_id, 0, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM subscriptions;
