import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Kysely } from 'kysely';
import type { SyncEngine, SyncEvent, SyncStats } from '../core/types.js';
import { LiveKyselyContext } from './context.js';
import type { LiveKysely } from './live.js';

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  isLoading: boolean;
  /** Re-run the query manually. */
  refresh(): void;
}

export interface SyncActions {
  engine: SyncEngine | undefined;
  isSyncing: boolean;
  error: unknown;
  sync(): Promise<SyncStats>;
  push(): Promise<SyncStats>;
  pull(): Promise<SyncStats>;
  compact(): Promise<string | null>;
  /** Invalidate all live queries (e.g. after a raw `sql` bulk import). */
  refresh(): void;
}

function useClient(): LiveKysely<any> {
  const client = useContext(LiveKyselyContext);
  if (!client) {
    throw new Error('sqlite-remote-sync/react: hooks require a <SyncProvider> above them');
  }
  return client;
}

/** The underlying live client (subscribe / notify / dispose / db / engine). */
export function useLiveKysely<DB = any>(): LiveKysely<DB> {
  return useClient() as LiveKysely<DB>;
}

/**
 * The live Kysely instance. Use it for CRUD; every `insertInto` / `updateTable`
 * / `deleteFrom` invalidates all `useQuery` results automatically.
 */
export function useKysely<DB = any>(): Kysely<DB> {
  return useClient().db as Kysely<DB>;
}

/**
 * Run a Kysely query and keep its result up to date. Re-runs on mount, when
 * `deps` change, and on every local or remote data change. Overlapping runs
 * are guarded so a slow result can never overwrite a newer one.
 *
 * `deps` must have a stable length (same as `useEffect` deps).
 */
export function useQuery<T, DB = any>(
  query: (db: Kysely<DB>) => Promise<T>,
  deps: readonly unknown[] = [],
): QueryResult<T> {
  const client = useClient();
  const [state, setState] = useState<{
    data: T | undefined;
    error: unknown;
    isLoading: boolean;
  }>({ data: undefined, error: undefined, isLoading: true });

  const latest = useRef(query);
  const seq = useRef(0);
  useEffect(() => {
    latest.current = query;
  });

  const run = useCallback((): void => {
    const id = ++seq.current;
    void Promise.resolve()
      .then(() => latest.current(client.db as Kysely<DB>))
      .then(
        (data) => {
          if (id === seq.current) setState({ data, error: undefined, isLoading: false });
        },
        (error: unknown) => {
          if (id === seq.current) setState((s) => ({ ...s, error, isLoading: false }));
        },
      );
  }, [client]);

  useEffect(() => {
    run();
    const unsubscribe = client.subscribe(() => run());
    return () => {
      unsubscribe();
      seq.current++; // invalidate any in-flight query
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, run, ...deps]);

  return { ...state, refresh: run };
}

/** The sync engine supplied to `<SyncProvider>`, if any. */
export function useSyncEngine(): SyncEngine | undefined {
  return useClient().engine;
}

/** The most recent engine event, useful for building a sync status indicator. */
export function useSyncEvent(): SyncEvent | undefined {
  const engine = useSyncEngine();
  const [event, setEvent] = useState<SyncEvent | undefined>(undefined);
  useEffect(() => {
    if (!engine) {
      setEvent(undefined);
      return;
    }
    return engine.on((ev) => setEvent(ev));
  }, [engine]);
  return event;
}

function mustEngine(engine: SyncEngine | undefined): SyncEngine {
  if (!engine) {
    throw new Error('sqlite-remote-sync/react: no SyncEngine configured on <SyncProvider>');
  }
  return engine;
}

/** Sync controls with a local `isSyncing` / `error` state. */
export function useSync(): SyncActions {
  const client = useClient();
  const engine = client.engine;
  const [isSyncing, setSyncing] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const run = useCallback(async <R>(op: () => Promise<R>): Promise<R> => {
    setSyncing(true);
    setError(undefined);
    try {
      return await op();
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setSyncing(false);
    }
  }, []);

  return useMemo<SyncActions>(() => {
    const wrapped = (op: () => Promise<SyncStats>): Promise<SyncStats> =>
      run(op).then((stats) => {
        client.notify();
        return stats;
      });
    return {
      engine,
      isSyncing,
      error,
      sync: () => wrapped(() => mustEngine(engine).sync()),
      push: () => wrapped(() => mustEngine(engine).push()),
      pull: () => wrapped(() => mustEngine(engine).pull()),
      compact: () => run(() => mustEngine(engine).compact()),
      refresh: () => client.notify(),
    };
  }, [engine, isSyncing, error, run, client]);
}
