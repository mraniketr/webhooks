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
  phase TEXT NOT NULL CHECK(phase IN ('pre','post')),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  query_json TEXT,
  payload_json TEXT,
  raw_body TEXT,
  ip TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
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

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  subscription_id INTEGER,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  response_preview TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_events_webhook_received ON events(webhook_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_webhook ON subscriptions(webhook_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_event ON deliveries(event_id);
