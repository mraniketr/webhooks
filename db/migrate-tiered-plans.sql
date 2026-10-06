-- Migration: tiered delivery queues (free / pro / dedicated) + configurable TPS.
-- Plan source of truth is users.plan; TPS limits live in plans and are
-- editable at runtime via the Admin API (no redeploy).
-- Apply with:
--   npx wrangler d1 execute hooklane-db --remote --file=./db/migrate-tiered-plans.sql

-- Runtime-editable per-tier TPS. window_seconds is the sliding window the
-- tps_limit applies to; burst_limit is the short-burst allowance enforced
-- alongside it (ingest rejects when either is exceeded).
CREATE TABLE IF NOT EXISTS plans (
  plan TEXT PRIMARY KEY CHECK(plan IN ('free','pro','dedicated')),
  tps_limit INTEGER NOT NULL,
  burst_limit INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL DEFAULT 60,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO plans (plan, tps_limit, burst_limit, window_seconds, updated_at) VALUES
  ('free', 10, 20, 60, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('pro', 100, 200, 60, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dedicated', 1000, 2000, 60, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- User tier. dedicated_queue holds the customer queue name, e.g.
-- 'hooklane-deliveries-ded-acme'. tps_override (requests/window) wins over
-- plans.tps_limit when set; NULL means use the plan default.
-- (SQLite has no IF NOT EXISTS for ADD COLUMN, so each statement is
-- idempotent only on fresh DBs — re-running against an already-migrated
-- DB will error on the duplicate column, which is safe to ignore.)
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN dedicated_queue TEXT;
ALTER TABLE users ADD COLUMN tps_override INTEGER;
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

UPDATE users SET plan='free' WHERE plan IS NULL OR plan NOT IN ('free','pro','dedicated');

CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
