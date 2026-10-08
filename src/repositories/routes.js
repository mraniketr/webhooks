// RouteConfigRepository — composite read for the router fan-out hot path.
// SRP: assembles { webhookRow, actions, subIds, subs } as ONE KV entry so a
// hit skips 3 D1 queries. Composes Webhook/Action/Subscription repos instead
// of issuing SQL itself (OCP: shape can evolve without touching tables).

import { Keys, kvGetOrLoad, ttlMs } from "./cache-policy.js";

export function createRouteConfigRepository({ db, cache, ctx, env, webhooks, actions, subscriptions }) {
  const ttl = () => ttlMs(env);
  return {
    async getCached(webhookId) {
      const t = ttl();
      return kvGetOrLoad(cache, ctx, Keys.route(webhookId), t.route, async () => {
        const [webhookRow, preActions, subs] = await Promise.all([
          db.first("SELECT id,name,user_id,filter_code FROM webhooks WHERE id=?", [webhookId])
            .catch(() => db.first("SELECT id,name,filter_code FROM webhooks WHERE id=?", [webhookId]).catch(() => null))
            .catch(() => db.first("SELECT id,name FROM webhooks WHERE id=?", [webhookId]).catch(() => null)),
          actions.listPreEnabled(webhookId),
          subscriptions.listEnabledForFanout(webhookId),
        ]);
        return {
          webhookRow: webhookRow || null,
          actions: preActions || [],
          subIds: subs.map((s) => s.id),
          subs,
        };
      });
    },

    async refreshWhenStaleEmpty(webhookId, route) {
      if (route && (route.subIds || []).length === 0 && !(route.subs || []).length) {
        try {
          const fresh = await subscriptions.listEnabledForFanout(webhookId);
          if (fresh.length > 0) {
            webhooks.invalidateRoute(webhookId);
            return { ...route, subIds: fresh.map((s) => s.id), subs: fresh };
          }
        } catch { /* keep cached route */ }
      }
      return route;
    },

    invalidate(webhookId) {
      webhooks.invalidateRoute(webhookId);
    },
  };
}
