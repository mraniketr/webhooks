// WebhookRepository — owns ALL reads/writes on the `webhooks` table.
// Hot-path lookups (by token / row) go through ICacheAccessor (KV-only).

import { Keys, kvGetOrLoad, ttlMs } from "./cache-policy.js";

export function createWebhookRepository({ db, cache, ctx, env }) {
  const ttl = () => ttlMs(env);
  return {
    async ensureFilterColumn() {
      try {
        const cols = await db.all("PRAGMA table_info(webhooks)");
        const names = new Set((cols || []).map((c) => c.name));
        if (!names.has("filter_code")) await db.exec("ALTER TABLE webhooks ADD COLUMN filter_code TEXT");
      } catch { /* callers fall back */ }
    },

    // Ingest hot path: POST /webhooks/:token. Caches active AND disabled
    // rows; the caller checks status.
    async findByTokenCached(token) {
      const t = ttl();
      return kvGetOrLoad(cache, ctx, Keys.token(token), t.token, async () =>
        db.first("SELECT id, user_id, name, token, status FROM webhooks WHERE token=?", [token]),
        t.negative);
    },

    async findRowCached(webhookId) {
      const t = ttl();
      return kvGetOrLoad(cache, ctx, Keys.webhookRow(webhookId), t.webhookRow, async () => {
        const row = await db.first("SELECT id,name,filter_code FROM webhooks WHERE id=?", [webhookId])
          .catch(() => null)
          ?? await db.first("SELECT id,name FROM webhooks WHERE id=?", [webhookId]).catch(() => null);
        return row;
      });
    },

    async findByIdAndUser(id, userId) {
      return db.first("SELECT * FROM webhooks WHERE id=? AND user_id=?", [id, userId]);
    },

    // Sample-context / preview flows need only id+name (no ownership check;
    // callers verify ownership separately).
    async findBasicById(id) {
      return db.first("SELECT id,name FROM webhooks WHERE id=?", [id]).catch(() => null);
    },

    async findFilterCodeById(id) {
      try {
        const row = await db.first("SELECT filter_code FROM webhooks WHERE id=?", [id]);
        return row?.filter_code ?? null;
      } catch {
        return null;
      }
    },

    async findOwnerWebhook(id, userId) {
      return db.first("SELECT id,name,token,status FROM webhooks WHERE id=? AND user_id=?", [id, userId]);
    },

    async findOwnerId(webhookId, userId) {
      return db.first("SELECT id FROM webhooks WHERE id=? AND user_id=?", [webhookId, userId]);
    },

    async listByUserWithCounts(userId) {
      return db.all(
        `SELECT w.*, COUNT(DISTINCT s.id) subscription_count FROM webhooks w
         LEFT JOIN subscriptions s ON s.webhook_id=w.id
         WHERE w.user_id=? GROUP BY w.id ORDER BY w.id DESC`, [userId]);
    },

    async listIdsByUser(userId) {
      return db.all("SELECT id FROM webhooks WHERE user_id=?", [userId]);
    },

    async countByUser(userId) {
      try {
        const row = await db.first("SELECT COUNT(*) AS n FROM webhooks WHERE user_id=?", [userId]);
        return Number(row?.n ?? 0);
      } catch {
        return 0;
      }
    },

    async create({ userId, name, token, filterCode, createdAt }) {
      await this.ensureFilterColumn();
      try {
        const res = await db.run(
          "INSERT INTO webhooks (user_id,name,token,filter_code,created_at) VALUES (?,?,?,?,?)",
          [userId, name, token, filterCode || null, createdAt]);
        return res.lastRowId;
      } catch {
        const res = await db.run(
          "INSERT INTO webhooks (user_id,name,token,created_at) VALUES (?,?,?,?)",
          [userId, name, token, createdAt]);
        return res.lastRowId;
      }
    },

    async updateFields(id, { name, status, filterCode }) {
      if (name !== undefined) await db.run("UPDATE webhooks SET name=? WHERE id=?", [name, id]);
      if (status !== undefined) await db.run("UPDATE webhooks SET status=? WHERE id=?", [status, id]);
      if (filterCode !== undefined) {
        await this.ensureFilterColumn();
        try {
          await db.run("UPDATE webhooks SET filter_code=? WHERE id=?", [filterCode, id]);
        } catch { /* old DB without column */ }
      }
    },

    invalidate({ id, token } = {}) {
      if (token) cache.del(Keys.token(token), ctx);
      if (id != null) {
        cache.del(Keys.route(id), ctx);
        cache.del(Keys.webhookRow(id), ctx);
      }
    },

    invalidateRoute(webhookId) {
      if (webhookId != null) cache.del(Keys.route(webhookId), ctx);
    },
  };
}
