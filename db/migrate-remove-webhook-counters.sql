-- Migration: drop webhook-level counters. Delivery stats live only in
-- subscription_counters / subscription_daily_counters (per subscription).
-- Apply with:
--   npx wrangler d1 execute hooklane-db --remote --file=./db/migrate-remove-webhook-counters.sql

DROP TABLE IF EXISTS webhook_daily_counters;
DROP TABLE IF EXISTS webhook_counters;
