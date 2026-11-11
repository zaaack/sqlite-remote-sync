import type { Capabilities, Row, SqliteAdapter, SqlResult, SqlValue } from './types.js';

/* ------------------------------------------------------------------ */
/* async mutex                                                         */
/* ------------------------------------------------------------------ */

/** Serializes engine operations so push/pull/compact never interleave. */
export function createMutex(): <T>(fn: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const previous = tail;
    tail = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/* ------------------------------------------------------------------ */
/* capability probe                                                    */
/* ------------------------------------------------------------------ */

/**
 * Detect optional SQLite features at runtime. Everything degrades gracefully:
 * older SQLite builds use `strftime('%s','now')` instead of
 * `unixepoch('subsec')`; runtimes without triggers can use `trackChange()`.
 */
export async function probeCapabilities(db: SqliteAdapter): Promise<Capabilities> {
  let clock: 'subsec' | 'seconds' = 'seconds';
  try {
    await db.run("SELECT unixepoch('subsec')");
    clock = 'subsec';
  } catch {
    /* SQLite < 3.42 */
  }

  let json = true;
  try {
    await db.run("SELECT json_object('a', 'b'), json_array('x')");
  } catch {
    json = false;
  }

  let printf = true;
  try {
    await db.run("SELECT printf('%013d', 1)");
  } catch {
    printf = false;
  }

  let triggers = true;
  try {
    await db.run('CREATE TEMP TABLE "_sync_probe_t" (x INTEGER)');
    await db.run('CREATE TEMP TRIGGER "_sync_probe_tr" AFTER INSERT ON "_sync_probe_t" BEGIN SELECT 1; END');
    await db.run('DROP TRIGGER "_sync_probe_tr"');
    await db.run('DROP TABLE "_sync_probe_t"');
  } catch {
    triggers = false;
  }

  const subsecondNowExpr =
    clock === 'subsec'
      ? "CAST(unixepoch('subsec') * 1000 AS INTEGER)"
      : "(CAST(strftime('%s','now') AS INTEGER) * 1000)";
  return { triggers, json, printf, clock, subsecondNowExpr };
}

/* ------------------------------------------------------------------ */
/* fromRaw - node:sqlite / bun:sqlite / better-sqlite3 / sql.js /      */
/*            op-sqlite / capacitor-sqlite / tauri sql / electron      */
/* ------------------------------------------------------------------ */

export interface RawSqlClient {
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlResult> | SqlResult;
  /** Optional. If omitted, BEGIN/COMMIT/ROLLBACK are issued on this client. */
  transaction?<T>(fn: (tx: RawSqlClient) => Promise<T> | T): Promise<T> | T;
  close?(): Promise<void> | void;
}

/**
 * Wrap any raw SQL client. Provide `transaction` when your driver has a
 * callback-based transaction API; otherwise BEGIN/COMMIT are used, which
 * requires a single, non-shared connection (the engine already serializes).
 */
export function fromRaw(client: RawSqlClient): SqliteAdapter {
  const run = async (sql: string, params?: readonly SqlValue[]): Promise<SqlResult> =>
    client.run(sql, params);

  const adapter: SqliteAdapter = {
    run,
    transaction: client.transaction
      ? async <T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T> =>
          (await client.transaction!((rawTx) => fn(fromRaw(rawTx as RawSqlClient)))) as T
      : async <T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T> => {
          await run('BEGIN IMMEDIATE');
          try {
            const result = await fn(adapter);
            await run('COMMIT');
            return result;
          } catch (e) {
            try {
              await run('ROLLBACK');
            } catch {
              /* ignore rollback failure */
            }
            throw e;
          }
        },
    ...(client.close ? { close: async () => client.close!() } : {}),
  };
  return adapter;
}

/* ------------------------------------------------------------------ */
/* fromKysely - all kysely-sqlite-tools dialects + Kysely SqliteDialect */
/* ------------------------------------------------------------------ */

/** Structural subset of Kysely's `CompiledQuery`. */
export interface CompiledQueryLike {
  sql: string;
  parameters: readonly unknown[];
  query?: unknown;
}

/**
 * Deliberately loose: a real `Kysely<DB>` has generic signatures that are not
 * structurally assignable to a narrow interface. `kysely` is an optional peer,
 * so we avoid importing its types here and cast at the boundary instead.
 */
export interface KyselyLike {
  executeQuery(query: any, options?: any): Promise<any>;
  transaction(): { execute(fn: (trx: any) => Promise<any>): Promise<any> };
}

export interface KyselyAdapterOptions {
  /**
   * Build a real `CompiledQuery`. Recommended when you use Kysely plugins that
   * inspect the query AST: `(sql, params) => CompiledQuery.raw(sql, params)`.
   * Defaults to a structural object (sufficient for every SQLite dialect).
   */
  compiledQuery?: (sql: string, params: unknown[]) => CompiledQueryLike;
}

const defaultCompiledQuery = (sql: string, params: unknown[]): CompiledQueryLike => ({
  sql,
  parameters: params,
  query: { kind: 'RawNode' },
});

/**
 * Adapt any Kysely instance (`Kysely<DB>` or a `Transaction<DB>`).
 * Works with kysely-generic-sqlite, dialect-wasm, dialect-wasqlite-worker,
 * dialect-sqlite-worker, dialect-bun-worker, dialect-tauri and the built-in
 * `SqliteDialect`.
 */
export function fromKysely(db: KyselyLike, options: KyselyAdapterOptions = {}): SqliteAdapter {
  const make = options.compiledQuery ?? defaultCompiledQuery;

  const run = async (sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> => {
    const r = await db.executeQuery(make(sql, [...params]));
    return {
      rows: (r.rows ?? []) as Row[],
      changes: Number(r.numAffectedRows ?? 0),
      ...(r.insertId !== undefined ? { insertId: r.insertId } : {}),
    };
  };

  const adapter: SqliteAdapter = {
    run,
    transaction: <T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T> =>
      db.transaction().execute((trx: KyselyLike) => fn(fromKysely(trx, options))),
  };
  return adapter;
}

/* ------------------------------------------------------------------ */
/* fromExecutor - kysely-generic-sqlite IGenericSqlite executor        */
/* ------------------------------------------------------------------ */

export interface GenericSqliteExecutor {
  query(
    isSelect: boolean,
    sql: string,
    parameters: readonly unknown[],
  ): Promise<{ rows?: unknown[]; insertId?: bigint; numAffectedRows?: bigint }>;
  close?(): Promise<void>;
}

const READ_SQL = /^\s*(select|pragma|with|values|explain)\b/i;

/**
 * Adapt a `kysely-generic-sqlite` executor directly, without a Kysely
 * instance. Useful inside a Web/Node worker where you own the executor.
 */
export function fromExecutor(executor: GenericSqliteExecutor): SqliteAdapter {
  const run = async (sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> => {
    const r = await executor.query(READ_SQL.test(sql), sql, params);
    return {
      rows: (r.rows ?? []) as Row[],
      changes: Number(r.numAffectedRows ?? 0),
      ...(r.insertId !== undefined ? { insertId: r.insertId } : {}),
    };
  };

  const adapter: SqliteAdapter = {
    run,
    transaction: async <T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T> => {
      await run('BEGIN IMMEDIATE');
      try {
        const result = await fn(adapter);
        await run('COMMIT');
        return result;
      } catch (e) {
        try {
          await run('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw e;
      }
    },
    ...(executor.close ? { close: () => executor.close!() } : {}),
  };
  return adapter;
}
