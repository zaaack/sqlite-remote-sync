import { compareTs } from './clock.js';
import type { CellState, ConflictResolver, ResolveContext, SyncConfig } from './types.js';

/**
 * The LWW-Map semilattice join.
 *
 * For each cell name, the winner is the candidate with the greatest
 * `(p, l, s)` triple. This operation is commutative, associative and
 * idempotent, so every replica converges to the same state regardless of the
 * order in which operations arrive — the essential property for correct
 * bidirectional sync. It never inspects arrival order, local identity or the
 * wall clock.
 */
export function joinCells(
  current: ReadonlyMap<string, CellState>,
  incoming: readonly CellState[],
): Map<string, CellState> {
  const out = new Map<string, CellState>(current);
  for (const c of incoming) {
    const cur = out.get(c.cell);
    if (!cur || compareTs(c, cur) > 0) {
      out.set(c.cell, { cell: c.cell, value: c.value, p: c.p, l: c.l, s: c.s });
    }
  }
  return out;
}

export const lwwResolver: ConflictResolver = {
  id: 'lww',
  resolve: (ctx: ResolveContext) => joinCells(ctx.current, ctx.incoming),
};

export const fieldLwwResolver: ConflictResolver = {
  id: 'field-lww',
  resolve: (ctx: ResolveContext) => joinCells(ctx.current, ctx.incoming),
};

/** Choose the configured resolver, defaulting to the built-in LWW join. */
export function resolveResolver(config: SyncConfig): ConflictResolver {
  if (config.resolver) return config.resolver;
  return config.strategy === 'field' ? fieldLwwResolver : lwwResolver;
}
