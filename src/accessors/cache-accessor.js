// ─── ICacheAccessor ─────────────────────────────────────────────────────────
// DIP: repositories depend on this interface, never on KV directly.
// Swap tomorrow (KV → Upstash, R2, D1-based cache, mock) without touching
// repositories.
//
// NOTE (serverless): there is intentionally NO in-memory implementation.
// Workers isolates are ephemeral and per-request; a Map cache is stale,
// unshared, and misleading. KV is the only cache tier.
//
// Two value shapes:
//   - JSON entries: { value, exp } envelope stored as text, TTL via
//     expirationTtl. getJson() returns undefined on miss/expiry.
//   - Raw counters: plain integer text for rate-limit windows.
//     incrCounter() is read-modify-write (same semantics as before — slight
//     over-admission under races is accepted; the Workers Rate-Limit binding
//     stays the hard ceiling).
//
// ctx (queue/execution context) is accepted per-call so puts/deletes can use
// waitUntil and never block the hot path.

/**
 * @typedef {Object} ICacheAccessor
 * @property {(key: string) => Promise<any|undefined>} getJson
 * @property {(key: string, value: any, ttlMs: number, ctx?: any) => void} setJson
 * @property {(key: string, ctx?: any) => void} del
 * @property {(key: string) => Promise<number|null>} getCounter
 * @property {(key: string, ttlSeconds: number) => Promise<number|null>} incrCounter
 * @property {() => boolean} available
 */

function runBackground(ctx, promise) {
  try {
    if (ctx?.waitUntil) ctx.waitUntil(promise.catch(() => {}));
    else promise.catch(() => {});
  } catch { /* best-effort */ }
}

/**
 * KV implementation of ICacheAccessor.
 * @param {any} kv - env.WEBHOOK_CACHE (duck-typed get/put/delete)
 * @returns {ICacheAccessor}
 */
export function createKvCacheAccessor(kv) {
  const binding = kv && typeof kv.get === "function" && typeof kv.put === "function" ? kv : null;
  return {
    available() {
      return Boolean(binding);
    },
    async getJson(key) {
      try {
        if (!binding) return undefined;
        const raw = await binding.get(key, "text");
        if (!raw) return undefined;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.exp <= Date.now()) return undefined;
        return parsed.value ?? undefined;
      } catch {
        return undefined;
      }
    },
    setJson(key, value, ttlMs, ctx) {
      try {
        if (!binding) return;
        const body = JSON.stringify({ value, exp: Date.now() + ttlMs });
        runBackground(ctx, binding.put(key, body, {
          expirationTtl: Math.max(1, Math.ceil(ttlMs / 1000)),
        }));
      } catch { /* L2 is best-effort */ }
    },
    del(key, ctx) {
      try {
        if (!binding || typeof binding.delete !== "function") return;
        runBackground(ctx, binding.delete(key));
      } catch { /* ignore */ }
    },
    async getCounter(key) {
      try {
        if (!binding) return null;
        const raw = await binding.get(key, "text");
        if (raw == null) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
      } catch {
        return null;
      }
    },
    async incrCounter(key, ttlSeconds) {
      try {
        if (!binding) return null;
        const raw = await binding.get(key, "text");
        const count = (raw ? parseInt(raw, 10) || 0 : 0) + 1;
        await binding.put(key, String(count), { expirationTtl: Math.max(1, Math.ceil(ttlSeconds)) });
        return count;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Fail-open no-op cache (used when no KV binding exists — e.g. unit tests,
 * `wrangler dev` without KV). Repositories treat "miss" as "load from DB",
 * so behaviour stays correct, just uncached.
 * @returns {ICacheAccessor}
 */
export function createNoopCacheAccessor() {
  return {
    available() { return false; },
    async getJson() { return undefined; },
    setJson() { /* no-op */ },
    del() { /* no-op */ },
    async getCounter() { return null; },
    async incrCounter() { return null; },
  };
}
