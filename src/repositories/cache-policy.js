// Shared cache key + TTL policy (SRP: one place owns key shapes and TTLs).
// Serverless note: KV ONLY — no in-memory Map. Every method takes ctx so
// writes go through waitUntil and never block the hot path.

export const Keys = {
  token: (token) => `wh:token:${token}`,
  route: (webhookId) => `wh:route:${webhookId}`,
  webhookRow: (webhookId) => `wh:row:${webhookId}`,
  subscription: (id) => `sub:${id}`,
  userTier: (userId) => `tier:user:${userId}`,
  PLANS: "plans:all",
};

function numEnv(env, name, fallbackSeconds) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallbackSeconds;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackSeconds;
}

export function ttlMs(env) {
  return {
    token: numEnv(env, "WEBHOOK_TOKEN_CACHE_TTL_SECONDS", 60) * 1000,
    route: numEnv(env, "WEBHOOK_CONFIG_CACHE_TTL_SECONDS", 30) * 1000,
    webhookRow: numEnv(env, "WEBHOOK_CONFIG_CACHE_TTL_SECONDS", 30) * 1000,
    subscription: numEnv(env, "SUBSCRIPTION_CACHE_TTL_SECONDS", 30) * 1000,
    tier: numEnv(env, "TIER_CACHE_TTL_SECONDS", 30) * 1000,
    plans: numEnv(env, "PLAN_CACHE_TTL_SECONDS", 15) * 1000,
    negative: 10 * 1000,
  };
}

// KV-only get-or-load. No single-flight Map (isolate-local state is useless
// on serverless); concurrent misses may both hit D1 — accepted, D1 handles it.
export async function kvGetOrLoad(cache, ctx, key, ttl, loader, negativeTtl) {
  const hit = await cache.getJson(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  if (value === null || value === undefined) {
    // Negative-cache briefly so token scans don't hammer D1.
    cache.setJson(key, null, negativeTtl, ctx);
    return null;
  }
  cache.setJson(key, value, ttl, ctx);
  return value;
}
