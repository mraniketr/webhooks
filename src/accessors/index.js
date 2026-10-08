// Composition root for accessors (DIP wiring).
// Workers call this once per request/batch and inject the result into
// repositories — repositories never touch `env` directly.

import { createD1DbAccessor } from "./db-accessor.js";
import { createKvCacheAccessor, createNoopCacheAccessor } from "./cache-accessor.js";

/**
 * Build the accessor pair for a request.
 * @param {any} env - worker env (expects DB, WEBHOOK_CACHE)
 * @returns {{ db: import("./db-accessor.js").IDbAccessor,
 *             cache: import("./cache-accessor.js").ICacheAccessor }}
 */
export function createAccessors(env) {
  const db = createD1DbAccessor(env?.DB);
  const cache = env?.WEBHOOK_CACHE
    ? createKvCacheAccessor(env.WEBHOOK_CACHE)
    : createNoopCacheAccessor();
  return { db, cache };
}

export { createD1DbAccessor } from "./db-accessor.js";
export { createKvCacheAccessor, createNoopCacheAccessor } from "./cache-accessor.js";
