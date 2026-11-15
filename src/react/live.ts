import type { Kysely, KyselyPlugin } from 'kysely';
import type { SyncEngine, SyncEvent } from '../core/types.js';
import { createSyncPlugin } from '../kysely-plugin.js';
import type { SyncPluginOptions } from '../kysely-plugin.js';

/**
 * Kysely query-builder node kinds that represent a write. Engine-internal
 * writes go through `db.executeQuery()` with a `RawNode` and are deliberately
 * excluded, so replay/ingest never invalidate live queries (no feedback loop).
 */
const WRITE_KINDS = new Set(['InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode']);

export interface LiveKyselyOptions {
  /** Sync engine used for auto-sync after writes and remote-change invalidation. */
  engine?: SyncEngine;
  /**
   * Attach `createSyncPlugin` so writes automatically trigger a push.
   * Defaults to `true` when `engine` is provided.
   */
  syncAfterWrite?: boolean;
  /** Options forwarded to `createSyncPlugin`. */
  syncPlugin?: SyncPluginOptions;
  /** Extra hook invoked on every invalidation (logging, telemetry, ...). */
  onChange?: () => void;
}

export interface LiveKysely<DB> {
  /** Kysely instance with the change-observer plugin attached. Use this for CRUD. */
  db: Kysely<DB>;
  engine?: SyncEngine;
  /** Subscribe to data changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Invalidate every live query. Call after raw `sql` writes, bulk imports or
   * any out-of-band change that did not go through the Kysely query builder.
   */
  notify(): void;
  /** Flush coalesced notifications, then flush any pending sync. */
  flush(): Promise<void>;
  /** Detach engine listeners and drop all subscribers. */
  dispose(): void;
}

function isWriteNode(node: unknown): boolean {
  return (
    !!node &&
    typeof node === 'object' &&
    WRITE_KINDS.has((node as { kind?: string }).kind ?? '')
  );
}

/**
 * Framework-agnostic core of the React plugin.
 *
 * Wraps a Kysely instance so that any `insertInto` / `updateTable` /
 * `deleteFrom` invalidates live queries, and (optionally) triggers a sync.
 * Writes applied by the engine itself are detected through `pull` events.
 */
export function createLiveKysely<DB>(
  db: Kysely<DB>,
  options: LiveKyselyOptions = {},
): LiveKysely<DB> {
  const { engine, onChange } = options;
  const listeners = new Set<() => void>();
  const pending = new Set<unknown>();
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let off: (() => void) | undefined;

  const syncPlugin =
    engine && options.syncAfterWrite !== false
      ? createSyncPlugin(engine, options.syncPlugin)
      : undefined;

  const emit = (): void => {
    scheduled = undefined;
    if (disposed) return;
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('sqlite-remote-sync/react: change subscriber threw', e);
      }
    }
    try {
      onChange?.();
    } catch (e) {
      console.error('sqlite-remote-sync/react: onChange threw', e);
    }
  };

  /** Coalesce bursts (transactions, imports) into one refresh. */
  const notify = (): void => {
    if (disposed || scheduled !== undefined) return;
    scheduled = setTimeout(emit, 0);
  };

  const plugin = {
    transformQuery(args: { queryId: unknown; node: any }): any {
      if (isWriteNode(args.node)) pending.add(args.queryId);
      return syncPlugin ? syncPlugin.transformQuery(args) : args.node;
    },
    async transformResult(args: { queryId: unknown; node: any; result: any }): Promise<any> {
      const result = syncPlugin ? await syncPlugin.transformResult(args) : args.result;
      if (pending.delete(args.queryId)) notify();
      return result;
    },
  };

  const live = db.withPlugin(plugin as unknown as KyselyPlugin);

  /** Lazily attached on first subscriber; StrictMode-safe (re-attachable). */
  const attach = (): void => {
    if (off || !engine || disposed) return;
    off = engine.on((event: SyncEvent) => {
      if (event.type === 'pull' && (event.stats?.appliedOps ?? 0) > 0) notify();
    });
  };
  const detach = (): void => {
    off?.();
    off = undefined;
  };

  return {
    db: live,
    ...(engine ? { engine } : {}),
    subscribe(listener) {
      listeners.add(listener);
      attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detach();
      };
    },
    notify,
    async flush() {
      if (scheduled !== undefined) {
        clearTimeout(scheduled);
        emit();
      }
      await syncPlugin?.flush();
    },
    dispose() {
      disposed = true;
      if (scheduled !== undefined) clearTimeout(scheduled);
      scheduled = undefined;
      detach();
      listeners.clear();
      pending.clear();
    },
  };
}
