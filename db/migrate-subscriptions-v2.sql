-- Migration: customizable subscriptions (templated URL / headers / JSON body)
-- + inbound query capture on events.
-- Run once per database with:
--   npx wrangler d1 execute hooklane-db --remote --file=./db/migrate-subscriptions-v2.sql
-- (The Worker also auto-adds these columns on first write via PRAGMA check,
-- so fresh `db/schema.sql` installs need no migration.)

ALTER TABLE subscriptions ADD COLUMN http_method TEXT DEFAULT 'POST';
ALTER TABLE subscriptions ADD COLUMN headers_json TEXT;
ALTER TABLE subscriptions ADD COLUMN payload_mode TEXT DEFAULT 'passthrough';
ALTER TABLE subscriptions ADD COLUMN payload_template TEXT;
ALTER TABLE events ADD COLUMN query_json TEXT;
