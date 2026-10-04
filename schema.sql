PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  google_sub TEXT UNIQUE
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

-- Subscription-level delivery stats (the ONLY analytics tables).
-- The analytics queue consumer UPSERTs here async; hot path writes nothing.
-- enqueued = delivery tasks fanned out per subscription;
-- delivered_ok / delivered_failed = per-subscription outcomes.
CREATE TABLE IF NOT EXISTS subscription_counters (
  subscription_id INTEGER PRIMARY KEY,
  webhook_id INTEGER NOT NULL,
  enqueued INTEGER NOT NULL DEFAULT 0,
  delivered_ok INTEGER NOT NULL DEFAULT 0,
  delivered_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
  FOREIGN KEY(webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_daily_counters (
  subscription_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  enqueued INTEGER NOT NULL DEFAULT 0,
  delivered_ok INTEGER NOT NULL DEFAULT 0,
  delivered_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, day),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_counters_webhook ON subscription_counters(webhook_id);
CREATE INDEX IF NOT EXISTS idx_sub_daily_day ON subscription_daily_counters(day);
