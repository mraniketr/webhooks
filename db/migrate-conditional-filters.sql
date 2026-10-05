-- Migration: conditional filters (issue #7).
-- Webhook-level filter drops the whole event when falsy;
-- subscription-level filter skips only that subscription when falsy.
-- Empty/NULL = allow everything (default).
-- Safe to run multiple times. Apply with:
--   npx wrangler d1 execute hooklane-db --remote --file=./db/migrate-conditional-filters.sql
-- (The Worker also auto-adds these columns on first write via PRAGMA check,
-- so fresh `db/schema.sql` installs need no migration.)

ALTER TABLE webhooks ADD COLUMN filter_code TEXT;
ALTER TABLE subscriptions ADD COLUMN filter_code TEXT;
