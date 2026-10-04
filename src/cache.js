// Hot-path cache for the webhook send flow.
//
// Goal: the ingest route (POST /webhooks/:token) and the queue fan-out
// (processEvent / processDelivery) must not pay a D1 round-trip on every
// event. This module adds a small, dependency-free, zero-infra cache on top
// of D1:
//
//   L1: in-memory Map with TTL, shared per isolate (globalThis). This is the
//       main win — hot webhooks stay resident and skip D1 entirely.
//   L2 (optional): a KV binding, used only if one is bound (duck-typed as
//       env.WEBHOOK_CACHE with get/put). No wrangler changes required; when
//       absent we simply skip L2. KV gives cross-isolate hits.
//
// Extra latency wins:
//   - single-flight: concurrent loads for the same key share one D1 query
//     (no thundering herd on bursts).
//   - negative caching: unknown tokens are cached briefly so token scans
//     don't hammer D1.
//
// Consistency: webhook/subscription edits call the invalidate* helpers.
// Stale reads can only last until the (short) TTL — default 60s for token
// lookups, 30s for route/subscription config. Both are tunable via env.
//
// No blocking: every cache access is synchronous except the D1 loader on a
// miss, and all loaders are safe to run concurrently via Promise.all at the
// call sites.

const GLOBAL_KEY = "__hooklane_hot_cache";
const INFLIGHT_KEY = "__hooklane_hot_cache_inflight";

const DEFAULTS = {
  tokenTtlMs: 60 * 1000,
  configTtlMs: 30 * 1000,
  subscriptionTtlMs: 30 * 1000,
  negativeTtlMs: 10 * 1000,
  maxEntries: 2000,
};

function numEnv(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ttls(env) {
  return {
    // Seconds in env for operator ergonomics, ms internally.
    tokenTtlMs: numEnv(env, "WEBHOOK_TOKEN_CACHE_TTL_SECONDS", DEFAULTS.tokenTtlMs / 1000) * 1000,
    configTtlMs: numEnv(env, "WEBHOOK_CONFIG_CACHE_TTL_SECONDS", DEFAULTS.configTtlMs / 1000) * 1000,
    subscriptionTtlMs: numEnv(env, "SUBSCRIPTION_CACHE_TTL_SECONDS", DEFAULTS.subscriptionTtlMs / 1000) * 1000,
    negativeTtlMs: DEFAULTS.negativeTtlMs,
    maxEntries: DEFAULTS.maxEntries,
  };
}

function store() {
  if (!globalThis[GLOBAL_KEY]) globalThis[GLOBAL_KEY] = new Map();
  return globalThis[GLOBAL_KEY];
}

function inflight() {
  if (!globalThis[INFLIGHT_KEY]) globalThis[INFLIGHT_KEY] = new Map();
  return globalThis[INFLIGHT_KEY];
}

function memoryGet(key) {
  const entry = store().get(key);
  if (!entry) return undefined;
  if (entry.exp <= Date.now()) {
    store().delete(key);
    return undefined;
  }
  // LRU refresh: re-insert to mark as recently used.
  store().delete(key);
  store().set(key, entry);
  return entry.value;
}

function memorySet(key, value, ttlMs) {
  const m = store();
  if (m.has(key)) m.delete(key);
  // Evict oldest while over capacity.
  while (m.size >= DEFAULTS.maxEntries) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
  m.set(key, { value, exp: Date.now() + ttlMs });
}

function memoryDelete(key) {
  store().delete(key);
}

function memoryDeleteByPrefix(prefix) {
  for (const key of [...store().keys()]) {
    if (key.startsWith(prefix)) store().delete(key);
  }
}

// Optional L2: KV binding if the operator adds one later. Duck-typed so
// the workers run fine without any new wrangler binding.
function kvBinding(env) {
  const kv = env?.WEBHOOK_CACHE;
  if (kv && typeof kv.get === "function" && typeof kv.put === "function") return kv;
  return null;
}

async function kvGet(env, key) {
  try {
    const kv = kvBinding(env);
    if (!kv) return undefined;
    const raw = await kv.get(key, "text");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.exp <= Date.now()) return undefined;
    return parsed.value ?? undefined;
  } catch {
    return undefined;
  }
}

function kvPut(env, ctx, key, value, ttlMs) {
  try {
    const kv = kvBinding(env);
    if (!kv) return;
    const body = JSON.stringify({ value, exp: Date.now() + ttlMs });
    const p = kv.put(key, body, { expirationTtl: Math.max(1, Math.ceil(ttlMs / 1000)) });
    // Don't block the hot path on L2 writes.
    if (ctx?.waitUntil) ctx.waitUntil(p.catch(() => {}));
    else p.catch(() => {});
  } catch { /* L2 is best-effort */ }
}

function kvDelete(env, ctx, key) {
  try {
    const kv = kvBinding(env);
    if (!kv || typeof kv.delete !== "function") return;
    const p = kv.delete(key);
    if (ctx?.waitUntil) ctx.waitUntil(p.catch(() => {}));
    else p.catch(() => {});
  } catch { /* ignore */ }
}

// Core: memory -> optional KV -> loader, with single-flight on the loader.
async function getOrLoad(env, ctx, key, ttlMs, loader, { negativeTtlMs = DEFAULTS.negativeTtlMs } = {}) {
  const hit = memoryGet(key);
  if (hit !== undefined) return hit;

  const kvHit = await kvGet(env, key);
  if (kvHit !== undefined) {
    memorySet(key, kvHit, Math.min(ttlMs, 10 * 1000));
    return kvHit;
  }

  const flights = inflight();
  const ongoing = flights.get(key);
  if (ongoing) return ongoing;

  const p = (async () => {
    try {
      const value = await loader();
      if (value === null || value === undefined) {
        // Cache misses briefly to absorb invalid-token scans.
        memorySet(key, null, negativeTtlMs);
        return null;
      }
      memorySet(key, value, ttlMs);
      kvPut(env, ctx, key, value, ttlMs);
      return value;
    } finally {
      flights.delete(key);
    }
  })();
  flights.set(key, p);
  return p;
}

function tokenKey(token) {
  return `wh:token:${token}`;
}
function routeKey(webhookId) {
  return `wh:route:${webhookId}`;
}
function webhookRowKey(webhookId) {
  return `wh:row:${webhookId}`;
}
function subscriptionKey(subscriptionId) {
  return `sub:${subscriptionId}`;
}

// Ingest hot path: POST /webhooks/:token looks up the webhook by token.
// Loader should return the webhook row or null. Both active + disabled rows
// are cached; the caller checks status after.
async function getWebhookByToken(env, ctx, token, loader) {
  const { tokenTtlMs, negativeTtlMs } = ttls(env);
  return getOrLoad(env, ctx, tokenKey(token), tokenTtlMs, loader, { negativeTtlMs });
}

// Queue fan-out hot path: webhook row + enabled pre-action + enabled
// subscription ids, cached as one entry so a hit skips 3 D1 queries.
async function getRouteConfig(env, ctx, webhookId, loader) {
  const { configTtlMs } = ttls(env);
  return getOrLoad(env, ctx, routeKey(webhookId), configTtlMs, loader);
}

async function getWebhookRow(env, ctx, webhookId, loader) {
  const { configTtlMs } = ttls(env);
  return getOrLoad(env, ctx, webhookRowKey(webhookId), configTtlMs, loader);
}

async function getSubscription(env, ctx, subscriptionId, loader) {
  const { subscriptionTtlMs, negativeTtlMs } = ttls(env);
  return getOrLoad(env, ctx, subscriptionKey(subscriptionId), subscriptionTtlMs, loader, { negativeTtlMs });
}

function invalidateWebhook(env, ctx, { id, token } = {}) {
  if (token) {
    memoryDelete(tokenKey(token));
    kvDelete(env, ctx, tokenKey(token));
  }
  if (id != null) {
    memoryDelete(routeKey(id));
    memoryDelete(webhookRowKey(id));
    kvDelete(env, ctx, routeKey(id));
    kvDelete(env, ctx, webhookRowKey(id));
  }
}

function invalidateRouteConfig(env, ctx, webhookId) {
  if (webhookId == null) return;
  memoryDelete(routeKey(webhookId));
  kvDelete(env, ctx, routeKey(webhookId));
}

function invalidateSubscription(env, ctx, subscriptionId) {
  if (subscriptionId == null) return;
  memoryDelete(subscriptionKey(subscriptionId));
  kvDelete(env, ctx, subscriptionKey(subscriptionId));
}

function invalidateAllSubscriptions(env, ctx, webhookId) {
  // We don't track sub ids per webhook in the cache index, so drop the
  // whole subscription prefix on bulk rewrites (saveSubscriptions). These
  // tables are small and re-warm on next delivery.
  if (webhookId == null) return;
  invalidateRouteConfig(env, ctx, webhookId);
  memoryDeleteByPrefix("sub:");
}

function clearHotCache() {
  store().clear();
  inflight().clear();
}

export {
  getOrLoad,
  getRouteConfig,
  getSubscription,
  getWebhookByToken,
  getWebhookRow,
  invalidateAllSubscriptions,
  invalidateRouteConfig,
  invalidateSubscription,
  invalidateWebhook,
  clearHotCache,
};
