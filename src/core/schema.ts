import type { Capabilities, SqliteAdapter, SyncConfig, TableConfig } from './types.js';
import { fingerprint, quoteIdent, quoteLiteral, sqlPkExpr, sqlRowExpr, utf8Encode } from './codec.js';

/** Names of the internal tables created in the user's database. */
export const SYNC = {
  meta: '_sync_meta',
  ctrl: '_sync_ctrl',
  clock: '_sync_clock',
  oplog: '_sync_oplog',
  cells: '_sync_cells',
  cursors: '_sync_cursors',
  replay: '_sync_replay',
  blobs: '_sync_blobs',
} as const;

export interface TableSchema {
  name: string;
  primaryKey: string[];
  /** Columns replicated, always including the primary key columns. */
  columns: string[];
}

/* ------------------------------------------------------------------ */
/* schema discovery                                                    */
/* ------------------------------------------------------------------ */

export async function discoverSchemas(
  db: SqliteAdapter,
  tables: readonly TableConfig[],
): Promise<TableSchema[]> {
  const out: TableSchema[] = [];
  for (const cfg of tables) {
    const info = await db.run(`PRAGMA table_info(${quoteIdent(cfg.name)})`);
    if (!info.rows.length) {
      throw new Error(`sqlite-remote-sync: table ${cfg.name} does not exist`);
    }
    const all = info.rows.map((r) => String(r.name));
    const pragmaPk = info.rows
      .filter((r) => Number(r.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((r) => String(r.name));
    const primaryKey = cfg.primaryKey.length ? [...cfg.primaryKey] : pragmaPk;
    if (!primaryKey.length) {
      throw new Error(`sqlite-remote-sync: table ${cfg.name} has no primary key; specify primaryKey`);
    }
    const requested = cfg.columns ?? all;
    for (const c of requested) {
      if (!all.includes(c)) {
        throw new Error(`sqlite-remote-sync: column ${cfg.name}.${c} does not exist`);
      }
    }
    const columns = [...new Set([...primaryKey, ...requested])];
    out.push({ name: cfg.name, primaryKey, columns });
  }
  return out;
}

/** Deterministic schema epoch: identical on every device with the same schema. */
export function computeEpoch(
  schemas: readonly TableSchema[],
  strategy: string,
  resolverId: string,
): string {
  const canonical = JSON.stringify(
    [...schemas]
      .map((s) => ({ n: s.name, pk: s.primaryKey, c: s.columns }))
      .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)),
  );
  return fingerprint(utf8Encode(`${canonical}|${strategy}|${resolverId}`));
}

/* ------------------------------------------------------------------ */
/* sync tables                                                         */
/* ------------------------------------------------------------------ */

const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "${SYNC.meta}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "${SYNC.ctrl}" (id INTEGER PRIMARY KEY CHECK (id = 1), replay INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO "${SYNC.ctrl}" (id, replay) VALUES (1, 0)`,
  `CREATE TABLE IF NOT EXISTS "${SYNC.clock}" (id INTEGER PRIMARY KEY CHECK (id = 1), p INTEGER NOT NULL, l INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO "${SYNC.clock}" (id, p, l) VALUES (1, 0, 0)`,
  `CREATE TABLE IF NOT EXISTS "${SYNC.oplog}" (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     tbl TEXT NOT NULL, pk TEXT NOT NULL, op TEXT NOT NULL,
     row TEXT, old_row TEXT, p INTEGER NOT NULL, l INTEGER NOT NULL, site TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS "_sync_oplog_range" ON "${SYNC.oplog}" (site, seq)`,
  `CREATE TABLE IF NOT EXISTS "${SYNC.cells}" (
     tbl TEXT NOT NULL, pk TEXT NOT NULL, cell TEXT NOT NULL,
     value TEXT, p INTEGER NOT NULL, l INTEGER NOT NULL, s TEXT NOT NULL,
     PRIMARY KEY (tbl, pk, cell)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS "${SYNC.cursors}" (site TEXT PRIMARY KEY, seq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "${SYNC.replay}" (
     tbl TEXT NOT NULL, pk TEXT NOT NULL, PRIMARY KEY (tbl, pk)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS "${SYNC.blobs}" (hash TEXT PRIMARY KEY, data BLOB NOT NULL)`,
];

/* ------------------------------------------------------------------ */
/* triggers                                                            */
/* ------------------------------------------------------------------ */

interface TriggerDef {
  name: string;
  sql: string;
}

/**
 * A trigger set for one table.
 *
 * The replay guard references `_sync_replay` — a table in the SAME database
 * as the user table. SQLite forbids main-table triggers from referencing
 * `temp` or attached databases, so a connection-local TEMP flag is not an
 * option. Instead the set of PKs currently being replayed is recorded in
 * `_sync_replay` inside the apply transaction; a crash rolls it back, so the
 * guard can never be left stuck. Writes to unrelated rows are still captured.
 */
export function makeTriggers(s: TableSchema, nowExpr: string): TriggerDef[] {
  const id = fingerprint(utf8Encode(s.name)).slice(0, 10);
  const table = quoteIdent(s.name);
  const lit = quoteLiteral(s.name);
  const pkNew = sqlPkExpr(s.primaryKey, 'NEW');
  const pkOld = sqlPkExpr(s.primaryKey, 'OLD');
  const guardNew = `NOT EXISTS (SELECT 1 FROM "${SYNC.replay}" WHERE tbl = ${lit} AND pk = ${pkNew})`;
  const guardOld = `NOT EXISTS (SELECT 1 FROM "${SYNC.replay}" WHERE tbl = ${lit} AND pk = ${pkOld})`;
  const samePk = `(${pkOld} IS ${pkNew})`;

  const clock = `UPDATE "${SYNC.clock}" SET
      l = CASE WHEN p >= (${nowExpr}) THEN l + 1 ELSE 0 END,
      p = MAX(p, (${nowExpr}))
    WHERE id = 1;`;

  const log = (op: 'put' | 'del', alias: 'NEW' | 'OLD', oldAlias?: 'OLD'): string =>
    `INSERT INTO "${SYNC.oplog}" (tbl, pk, op, row, old_row, p, l, site)
       SELECT ${lit}, ${sqlPkExpr(s.primaryKey, alias)}, '${op}',
              ${sqlRowExpr(s.columns, alias)},
              ${oldAlias ? sqlRowExpr(s.columns, oldAlias) : 'NULL'}, p, l,
              (SELECT value FROM "${SYNC.meta}" WHERE key = 'site')
         FROM "${SYNC.clock}" WHERE id = 1;`;

  const def = (suffix: string, body: string): TriggerDef => ({
    name: `_s_${suffix}_${id}`,
    sql: `CREATE TRIGGER "_s_${suffix}_${id}" ${body}`,
  });

  return [
    def('it', `AFTER INSERT ON ${table} WHEN ${guardNew} BEGIN ${clock} ${log('put', 'NEW')} END`),
    def(
      'ut',
      `AFTER UPDATE ON ${table} WHEN ${samePk} AND ${guardNew} BEGIN ${clock} ${log('put', 'NEW', 'OLD')} END`,
    ),
    def(
      'uc',
      `AFTER UPDATE ON ${table} WHEN (NOT ${samePk}) AND ${guardOld} AND ${guardNew} BEGIN ${clock} ${log('del', 'OLD', 'OLD')} ${log('put', 'NEW')} END`,
    ),
    def('dt', `AFTER DELETE ON ${table} WHEN ${guardOld} BEGIN ${clock} ${log('del', 'OLD', 'OLD')} END`),
  ];
}

async function dropSyncTriggers(db: SqliteAdapter): Promise<void> {
  const rows = await db.run(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB '_s_*'",
  );
  for (const r of rows.rows) {
    await db.run(`DROP TRIGGER IF EXISTS ${quoteIdent(String(r.name))}`);
  }
}

/**
 * Create/refresh all sync tables and triggers. Called inside a transaction by
 * the engine. Rebuilds triggers whenever the schema, strategy or resolver
 * changes, and defensively clears the replay guard.
 */
export async function installSchema(
  db: SqliteAdapter,
  config: SyncConfig,
  cap: Capabilities,
  schemas: readonly TableSchema[],
  resolverId: string,
): Promise<string> {
  for (const sql of DDL) await db.run(sql);
  await db.run(`DELETE FROM "${SYNC.replay}"`);
  await db.run(`UPDATE "${SYNC.ctrl}" SET replay = 0 WHERE id = 1`);

  const strategy = config.strategy ?? 'row';
  const epoch = computeEpoch(schemas, strategy, resolverId);
  const triggerSet = schemas.flatMap((s) => makeTriggers(s, cap.subsecondNowExpr));
  const hash = fingerprint(utf8Encode(triggerSet.map((t) => t.sql).join('\n')));

  const currentHash = await readMeta(db, 'trigger_hash');
  const currentEpoch = await readMeta(db, 'schema_epoch');
  if (currentHash !== hash || currentEpoch !== epoch) {
    await dropSyncTriggers(db);
    for (const t of triggerSet) await db.run(t.sql);
    await writeMeta(db, 'trigger_hash', hash);
    await writeMeta(db, 'schema_epoch', epoch);
    await writeMeta(db, 'resolver', resolverId);
    await writeMeta(db, 'strategy', strategy);
  }
  await writeMeta(db, 'site', config.siteId);
  return epoch;
}

/* ------------------------------------------------------------------ */
/* small state helpers (usable with a transaction-scoped adapter)      */
/* ------------------------------------------------------------------ */

export async function readMeta(db: SqliteAdapter, key: string): Promise<string | null> {
  const r = await db.run(`SELECT value FROM "${SYNC.meta}" WHERE key = ?`, [key]);
  return r.rows.length ? String(r.rows[0]!.value) : null;
}

export async function writeMeta(db: SqliteAdapter, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO "${SYNC.meta}" (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export async function readClock(db: SqliteAdapter): Promise<{ p: number; l: number }> {
  const r = await db.run(`SELECT p, l FROM "${SYNC.clock}" WHERE id = 1`);
  return { p: Number(r.rows[0]?.p ?? 0), l: Number(r.rows[0]?.l ?? 0) };
}

export async function writeClock(db: SqliteAdapter, p: number, l: number): Promise<void> {
  await db.run(`UPDATE "${SYNC.clock}" SET p = ?, l = ? WHERE id = 1`, [p, l]);
}

export async function getCursor(db: SqliteAdapter, site: string): Promise<number> {
  const r = await db.run(`SELECT seq FROM "${SYNC.cursors}" WHERE site = ?`, [site]);
  return r.rows.length ? Number(r.rows[0]!.seq) : 0;
}

export async function setCursor(db: SqliteAdapter, site: string, seq: number): Promise<void> {
  await db.run(
    `INSERT INTO "${SYNC.cursors}" (site, seq) VALUES (?, ?)
       ON CONFLICT(site) DO UPDATE SET seq = MAX("${SYNC.cursors}".seq, excluded.seq)`,
    [site, seq],
  );
}

export async function getAllCursors(db: SqliteAdapter): Promise<Record<string, number>> {
  const r = await db.run(`SELECT site, seq FROM "${SYNC.cursors}"`);
  const out: Record<string, number> = {};
  for (const row of r.rows) out[String(row.site)] = Number(row.seq);
  return out;
}
