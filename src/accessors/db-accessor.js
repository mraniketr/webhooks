// ─── IDbAccessor ─────────────────────────────────────────────────────────────
// DIP: repositories depend on this interface, never on D1 directly.
// Swap the implementation tomorrow (D1 → Postgres, Neon, SQLite, mock in
// tests) without touching any repository.
//
// Contract:
//   first(sql, params) → Promise<row | null>
//   all(sql, params)   → Promise<row[]>
//   run(sql, params)   → Promise<{ lastRowId: number, changes: number }>
//   batch(ops)         → Promise<void>  where ops = [{ sql, params }]
//
// All methods fail-soft by contract of the CALLER deciding fallback — the
// accessor itself only translates transport errors into thrown Errors, it
// never swallows them (repositories decide fail-open vs fail-closed).

/**
 * @typedef {Object} DbRunResult
 * @property {number} lastRowId
 * @property {number} changes
 */

/**
 * @typedef {Object} IDbAccessor
 * @property {(sql: string, params?: any[]) => Promise<any|null>} first
 * @property {(sql: string, params?: any[]) => Promise<any[]>} all
 * @property {(sql: string, params?: any[]) => Promise<DbRunResult>} run
 * @property {(ops: Array<{sql: string, params?: any[]}>) => Promise<void>} batch
 * @property {(sql: string) => Promise<void>} exec
 */

/**
 * D1 implementation of IDbAccessor. Wraps a D1Database binding.
 * @param {any} d1 - env.DB (duck-typed: must have prepare())
 * @returns {IDbAccessor}
 */
export function createD1DbAccessor(d1) {
  const mustHaveDb = () => {
    if (!d1 || typeof d1.prepare !== "function") {
      throw new Error("DB binding unavailable");
    }
    return d1;
  };
  return {
    async first(sql, params = []) {
      const row = await mustHaveDb().prepare(sql).bind(...params).first();
      return row ?? null;
    },
    async all(sql, params = []) {
      const res = await mustHaveDb().prepare(sql).bind(...params).all();
      return res?.results || [];
    },
    async run(sql, params = []) {
      const res = await mustHaveDb().prepare(sql).bind(...params).run();
      return {
        lastRowId: Number(res?.meta?.last_row_id) || 0,
        changes: Number(res?.meta?.changes) || 0,
      };
    },
    async batch(ops = []) {
      const db = mustHaveDb();
      await db.batch(ops.map((o) => db.prepare(o.sql).bind(...(o.params || []))));
    },
    async exec(sql) {
      await mustHaveDb().prepare(sql).run();
    },
  };
}

/**
 * In-memory IDbAccessor for unit tests / wrangler dev without D1.
 * Handlers register per-SQL-prefix responders. Anything unregistered throws
 * so tests fail loudly instead of silently returning nulls.
 */
export function createMemoryDbAccessor(handlers = {}) {
  const match = (sql) => {
    for (const [prefix, fn] of Object.entries(handlers)) {
      if (sql.startsWith(prefix)) return fn;
    }
    return null;
  };
  return {
    async first(sql, params = []) {
      const fn = match(sql);
      if (!fn) throw new Error(`MemoryDb: no handler for: ${sql.slice(0, 80)}`);
      return (await fn(params, "first")) ?? null;
    },
    async all(sql, params = []) {
      const fn = match(sql);
      if (!fn) throw new Error(`MemoryDb: no handler for: ${sql.slice(0, 80)}`);
      return (await fn(params, "all")) || [];
    },
    async run(sql, params = []) {
      const fn = match(sql);
      if (!fn) throw new Error(`MemoryDb: no handler for: ${sql.slice(0, 80)}`);
      return (await fn(params, "run")) || { lastRowId: 0, changes: 0 };
    },
    async batch(ops = []) {
      for (const o of ops) await this.run(o.sql, o.params || []);
    },
    async exec(sql) {
      const fn = match(sql);
      if (fn) await fn([], "run");
    },
  };
}
