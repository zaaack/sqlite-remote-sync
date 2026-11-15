import { createContext, createElement, useMemo, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { Kysely } from 'kysely';
import { createLiveKysely } from './live.js';
import type { LiveKysely, LiveKyselyOptions } from './live.js';

/** Advanced escape hatch: the underlying live client. */
export const LiveKyselyContext = createContext<LiveKysely<any> | null>(null);

export interface SyncProviderProps<DB> extends LiveKyselyOptions {
  /** A Kysely instance backed by SQLite (any kysely-sqlite-tools dialect). */
  db: Kysely<DB>;
  children?: ReactNode;
}

/**
 * Provides a live Kysely instance to the tree. All `useQuery` results below it
 * re-run automatically whenever data changes — locally (through the Kysely
 * query builder) or remotely (after the sync engine applies a pull).
 */
export function SyncProvider<DB>(props: SyncProviderProps<DB>): ReactElement {
  const { db, engine, syncAfterWrite, syncPlugin, onChange, children } = props;

  // Options are read when the client is (re)created. Keeping them in a ref
  // avoids rebuilding the client on every render because of inline callbacks.
  const opts = useRef<LiveKyselyOptions>({ syncAfterWrite, syncPlugin, onChange });
  opts.current = { syncAfterWrite, syncPlugin, onChange };

  const live = useMemo(
    () => createLiveKysely(db, { engine, ...opts.current }),
    [db, engine],
  );

  return createElement(LiveKyselyContext.Provider, { value: live }, children);
}
