// ActionRepository — owns ALL reads/writes on the `actions` table.
// Only pre-actions exist (post phase removed).

export function createActionRepository({ db }) {
  return {
    async listPreEnabled(webhookId) {
      const rows = await db.all(
        "SELECT * FROM actions WHERE webhook_id=? AND enabled=1 AND phase='pre' ORDER BY sort_order, id",
        [webhookId]).catch(() => []);
      return rows;
    },

    async listPreAll(webhookId) {
      const rows = await db.all(
        "SELECT id,phase,name,code,sort_order,enabled FROM actions WHERE webhook_id=? AND phase='pre' ORDER BY sort_order,id",
        [webhookId]);
      return rows;
    },

    async findPreCode(webhookId) {
      return db.first(
        "SELECT code FROM actions WHERE webhook_id=? AND enabled=1 AND phase='pre' ORDER BY sort_order,id LIMIT 1",
        [webhookId]);
    },

    // Replace the webhook's action list. Caller invalidates route config.
    async saveAll(webhookId, actions) {
      await db.run("DELETE FROM actions WHERE webhook_id=?", [webhookId]);
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        await db.run(
          "INSERT INTO actions (webhook_id,phase,name,code,sort_order,enabled) VALUES (?,?,?,?,?,?)",
          [webhookId, a.phase, a.name, a.code, i, a.enabled]);
      }
    },
  };
}
