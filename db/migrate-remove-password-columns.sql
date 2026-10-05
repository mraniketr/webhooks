-- Remove legacy password columns (password auth removed, Google SSO only).
-- Already applied to remote hooklane-db. Safe to re-run: second DROP fails
-- harmlessly if the column is already gone.
--   npx wrangler d1 execute hooklane-db --remote --file=./db/migrate-remove-password-columns.sql
ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users DROP COLUMN password_salt;
