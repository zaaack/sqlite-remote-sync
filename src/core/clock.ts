import type { Capabilities, Ts } from './types.js';

/**
 * Hybrid Logical Clock.
 *
 * A timestamp is the triple `(p, l, s)`: physical milliseconds, a logical
 * counter, and the originating site id. Comparison is lexicographic over the
 * triple using INTEGER arithmetic (never a padded string), so there is no
 * overflow and the order is total.
 *
 * Ordering is separated from delivery: per-site `seq` numbers drive cursors
 * and contiguous ranges, while the HLC only decides LWW conflicts. This keeps
 * clock skew from causing missed pulls.
 */

export function compareTs(a: Ts, b: Ts): number {
  if (a.p !== b.p) return a.p < b.p ? -1 : 1;
  if (a.l !== b.l) return a.l < b.l ? -1 : 1;
  return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
}

export function isNewer(a: Ts, b: Ts): boolean {
  return compareTs(a, b) > 0;
}

export function maxTs(a: Ts, b: Ts): Ts {
  return compareTs(a, b) >= 0 ? a : b;
}

/** SQL expression for "now" in milliseconds, adapted to the SQLite version. */
export function nowMsExpr(cap: Capabilities): string {
  return cap.clock === 'subsec'
    ? "CAST(unixepoch('subsec') * 1000 AS INTEGER)"
    : "(CAST(strftime('%s','now') AS INTEGER) * 1000)";
}

export function nowMs(): number {
  return Date.now();
}

/**
 * Local send rule. Returns the new clock state and the emitted timestamp.
 * Used by the trigger generator (as SQL) and by `trackChange()` (in JS).
 */
export function hlcSend(local: { p: number; l: number }, now: number, site: string): { clock: { p: number; l: number }; ts: Ts } {
  const p = Math.max(local.p, now);
  const l = local.p >= now ? local.l + 1 : 0;
  return { clock: { p, l }, ts: { p, l, s: site } };
}

/**
 * HLC receive rule, implemented as a pure max/join (NOT an increment).
 *
 * A replay is at-least-once, so the fold MUST be idempotent: re-applying the
 * same op must not change the clock. `max` is commutative, associative and
 * idempotent, and still guarantees that the next local send produces a
 * timestamp strictly greater than every received op.
 */
export function hlcReceive(
  local: { p: number; l: number },
  remote: { p: number; l: number },
  now: number,
): { p: number; l: number } {
  return {
    p: Math.max(local.p, remote.p, now),
    l: Math.max(local.l, remote.l),
  };
}

/** Fold a whole batch of received timestamps in one shot. */
export function foldBatch(
  local: { p: number; l: number },
  received: readonly { p: number; l: number }[],
  now: number,
): { p: number; l: number } {
  let p = Math.max(local.p, now);
  let l = local.l;
  for (const r of received) {
    p = Math.max(p, r.p);
    l = Math.max(l, r.l);
  }
  return { p, l };
}

export function formatTs(t: Ts): string {
  return `${t.p}:${t.l}:${t.s}`;
}

/** SQL predicate: is the candidate (`$p`,`$l`,`$s`) newer than stored columns? */
export const SQL_NEWER = `(excluded.p > _sync_cells.p) OR (excluded.p = _sync_cells.p AND excluded.l > _sync_cells.l) OR (excluded.p = _sync_cells.p AND excluded.l = _sync_cells.l AND excluded.s > _sync_cells.s)`;
