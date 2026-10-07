-- Migration: plans v2 — free / pro / dedicated with configurable limits + pricing.
-- Canonical plan names are 'free', 'pro', 'dedicated' ('shared' is aliased
-- to 'pro' in code for backward compatibility).
--
-- New columns (NULL = unlimited, except price_cents which defaults to 0):
--   daily_limit              max ingest events per calendar day (UTC) per user
--   max_webhooks             max webhooks per user
--   max_subs_per_webhook     max subscriptions per webhook
--   price_cents              price placeholder for later billing (0 = free)
--   price_display            human label shown on the Plans page, e.g. "$19/mo"
--   infra                    'shared' or 'dedicated' (display + routing hint)
--   description              short marketing line shown on the Plans page
--
-- TPS semantics: tps_limit applies per window_seconds (sustained average).
-- "1 TPS" is stored as tps_limit=60, window_seconds=60 (≈1/sec sustained);
-- "100 TPS" as tps_limit=6000, window_seconds=60.
-- All values stay editable at runtime via the Admin API (no redeploy).
--
-- Apply with (dev):
--   npx wrangler d1 execute dev-hooklane-db --config wrangler.dev.jsonc --remote --file=./db/migrate-plans-v2.sql
-- Apply with (prod):
--   npx wrangler d1 execute hooklane-db --remote --file=./db/migrate-plans-v2.sql

-- 1) Recreate plans with the wider schema (SQLite cannot widen a CHECK via ALTER).
CREATE TABLE IF NOT EXISTS plans_new (
  plan TEXT PRIMARY KEY CHECK(plan IN ('free','shared','dedicated','pro')),
  tps_limit INTEGER NOT NULL,
  burst_limit INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL DEFAULT 60,
  daily_limit INTEGER,
  max_webhooks INTEGER,
  max_subs_per_webhook INTEGER,
  price_cents INTEGER NOT NULL DEFAULT 0,
  price_display TEXT NOT NULL DEFAULT '$0',
  infra TEXT NOT NULL DEFAULT 'shared',
  description TEXT,
  updated_at TEXT NOT NULL
);

-- 2) Carry over existing rows; fold any 'shared' rows into 'pro'.
INSERT OR REPLACE INTO plans_new
  (plan, tps_limit, burst_limit, window_seconds, daily_limit, max_webhooks,
   max_subs_per_webhook, price_cents, price_display, infra, description, updated_at)
SELECT
  CASE WHEN plan = 'shared' THEN 'pro' ELSE plan END,
  tps_limit, burst_limit, window_seconds,
  CASE WHEN plan = 'dedicated' THEN NULL WHEN plan IN ('pro','shared') THEN 10000 ELSE 1000 END,
  CASE WHEN plan = 'dedicated' THEN NULL WHEN plan IN ('pro','shared') THEN 10 ELSE 2 END,
  CASE WHEN plan = 'dedicated' THEN NULL WHEN plan IN ('pro','shared') THEN 10 ELSE 3 END,
  CASE WHEN plan IN ('pro','shared') THEN 1900 ELSE 0 END,
  CASE WHEN plan IN ('pro','shared') THEN '$19/mo' WHEN plan = 'dedicated' THEN 'Custom' ELSE '$0' END,
  CASE WHEN plan = 'dedicated' THEN 'dedicated' ELSE 'shared' END,
  CASE WHEN plan IN ('pro','shared') THEN 'Shared infra · higher throughput'
       WHEN plan = 'dedicated' THEN 'Isolated queues · no limits'
       ELSE 'Shared infra · for trying things out' END,
  updated_at
FROM plans;

-- 3) Seed any missing canonical rows with the spec defaults:
--    free:      1 TPS (≈60/min),   1,000/day,  max 2 webhooks, max 3 subs/webhook
--    pro:     100 TPS (≈6000/min), 10,000/day, max 10 webhooks, max 10 subs/webhook
--    dedicated: no limits (very high TPS ceiling so the gate stays pass-through,
--               NULL daily/max = unlimited)
INSERT OR IGNORE INTO plans_new
  (plan, tps_limit, burst_limit, window_seconds, daily_limit, max_webhooks,
   max_subs_per_webhook, price_cents, price_display, infra, description, updated_at)
VALUES
  ('free', 60, 120, 60, 1000, 2, 3, 0, '$0', 'shared',
   'Shared infra · for trying things out', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('pro', 6000, 12000, 60, 10000, 10, 10, 1900, '$19/mo', 'shared',
   'Shared infra · higher throughput', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dedicated', 100000, 200000, 60, NULL, NULL, NULL, 0, 'Custom', 'dedicated',
   'Isolated queues · no limits', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 4) Swap in the new table and drop any leftover 'shared' row.
DROP TABLE IF EXISTS plans;
ALTER TABLE plans_new RENAME TO plans;
DELETE FROM plans WHERE plan = 'shared';

-- 5) Move existing users off 'shared'.
UPDATE users SET plan = 'pro' WHERE plan = 'shared';
UPDATE users SET plan = 'free' WHERE plan IS NULL OR plan NOT IN ('free','pro','dedicated');

CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
