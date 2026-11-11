import type { SyncEngine } from './core/types.js';

/**
 * A Kysely plugin that triggers a sync right after a write query completes.
 *
 * It implements Kysely's `KyselyPlugin` shape structurally (no hard import of
 * `kysely`), so it works with every kysely-sqlite-tools dialect. Write queries
 * are detected in `transformQuery` and the debounced sync is scheduled in
 * `transformResult`, i.e. AFTER the statement succeeded.
 *
 * Reentrancy: the engine sets `isSyncing()` during push/pull/compact, and its
 * own replay/ingest writes go through this same plugin. Those are ignored, so
 * there is no feedback loop.
 */
export interface SyncPluginOptions {
  /** `'push'` (default, cheapest) or `'sync'` (full bidirectional) after a write. */
  mode?: 'push' | 'sync';
  /** Coalesce bursts of writes. Default 150ms. */
  debounceMs?: number;
  /** Error handler; if omitted, errors are swallowed (use `engine.on('error')`). */
  onError?: (error: unknown) => void;
  /** Custom write detector. Overrides the built-in Insert/Update/Delete check. */
  shouldTrigger?: (node: any) => boolean;
}

export interface SyncKyselyPlugin {
  transformQuery(args: { queryId: unknown; node: any }): any;
  transformResult(args: { queryId: unknown; node: any; result: any }): Promise<any>;
  /** Cancel pending debounce and fire immediately. */
  flush(): Promise<void>;
}

const WRITE_KINDS = new Set(['InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode']);

function isWriteNode(node: any, predicate?: (node: any) => boolean): boolean {
  if (predicate) return predicate(node);
  if (!node || typeof node !== 'object') return false;
  if (WRITE_KINDS.has(node.kind)) return true;
  if (node.kind === 'RawNode') {
    const fragments: unknown[] = node.sqlFragments ?? [];
    const sql = fragments.map((f) => (typeof f === 'string' ? f : '')).join(' ');
    return /^\s*(insert|update|delete|replace)\b/i.test(sql);
  }
  return false;
}

export function createSyncPlugin(
  engine: SyncEngine,
  options: SyncPluginOptions = {},
): SyncKyselyPlugin {
  const mode = options.mode ?? 'push';
  const debounceMs = options.debounceMs ?? 150;
  const pending = new Map<unknown, boolean>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fire = async (): Promise<void> => {
    try {
      if (mode === 'sync') await engine.sync();
      else await engine.push();
    } catch (e) {
      options.onError?.(e);
    }
  };

  const schedule = (): void => {
    if (engine.isSyncing()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void fire();
    }, debounceMs);
  };

  return {
    transformQuery(args) {
      if (isWriteNode(args.node, options.shouldTrigger)) pending.set(args.queryId, true);
      return args.node;
    },
    async transformResult(args) {
      if (pending.get(args.queryId)) {
        pending.delete(args.queryId);
        schedule();
      }
      return args.result;
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      await fire();
    },
  };
}

/** Convenience: `const db = attachSyncPlugin(baseDb, engine)` (uses `withPlugin`). */
export function attachSyncPlugin<T>(db: T, engine: SyncEngine, options?: SyncPluginOptions): T {
  const withPlugin = (db as { withPlugin?: (p: unknown) => T }).withPlugin;
  if (typeof withPlugin !== 'function') {
    throw new Error('sqlite-remote-sync: the Kysely instance has no withPlugin() method');
  }
  return withPlugin.call(db, createSyncPlugin(engine, options));
}
