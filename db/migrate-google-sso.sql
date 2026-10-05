-- Google SSO: link Google subject to existing users.
-- Run once on existing DBs (fresh DBs already get this from db/schema.sql):
--   npx wrangler d1 execute hooklane-db --remote --file=./db/migrate-google-sso.sql
-- Safe to run multiple times (ALTER fails silently if column exists in some clients;
-- if your client errors, run the two statements separately and ignore "duplicate column").
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);
