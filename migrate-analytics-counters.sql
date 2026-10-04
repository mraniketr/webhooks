-- Optimization: aggregate-only analytics. No per-event rows on the hot path.
-- Event status is observed via structured worker logs (observability),
-- counts are maintained async by the analytics queue consumer.
-- Apply with:
--   npx wrangler d1 execute hooklane-db --remote --file=./migrate-analytics-counters.sql

-- Per-webhook lifetime totals. Single UPSERT per (webhook, day, field) batch.
CREATE TABLE IF NOT EXISTS webhook_counters (
  webhook_id INTEGER PRIMARY KEY,
  received INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  delivered_ok INTEGER NOT NULL DEFAULT 0,
  delivered_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

-- Per-webhook per-day buckets for graphs. One row per webhook per day.
CREATE TABLE IF NOT EXISTS webhook_daily_counters (
  webhook_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  delivered_ok INTEGER NOT NULL DEFAULT 0,
  delivered_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (webhook_id, day),
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_counters_day ON webhook_daily_counters(day);

-- NOTE: legacy `events` / `deliveries` tables are left in place for existing
-- history but are no longer written on the hot path.
