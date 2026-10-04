PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'pre' CHECK(phase IN ('pre')),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  http_method TEXT NOT NULL DEFAULT 'POST',
  headers_json TEXT,
  payload_mode TEXT NOT NULL DEFAULT 'passthrough',
  payload_template TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_webhook ON subscriptions(webhook_id);

-- Aggregate-only analytics (hot path writes nothing per-event; the
-- analytics queue consumer UPSERTs here async).
CREATE TABLE IF NOT EXISTS webhook_counters (
  webhook_id INTEGER PRIMARY KEY,
  received INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  delivered_ok INTEGER NOT NULL DEFAULT 0,
  delivered_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

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
