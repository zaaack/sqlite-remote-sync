# Conflict resolution

> [← Docs index](./README.md)

The library resolves conflicts with a **state-based CRDT**: an LWW-Map
semilattice join. This page explains the model, the two built-in strategies and
how to write a correct custom `ConflictResolver`.

---

## The model: cells, not rows

Replicated state is a map of **cells**. Each cell has a name, an encoded value
(or `null` for a tombstone) and a timestamp:

```ts
interface Cell {
  cell: string;        // '*' | '$del' | a column name
  value: string | null;
  p: number;           // physical ms
  l: number;           // logical counter
  s: string;           // originating siteId
}
```

`Ts = (p, l, s)` is a **total order** compared lexicographically. `s` breaks
ties, so two writes at the exact same millisecond still have a deterministic
winner. `compareTs(a, b)` is exported for custom resolvers.

| `cell` | Meaning | Used by |
| --- | --- | --- |
| `'*'` | The whole row (JSON of encoded cells) | `strategy: 'row'` |
| `'$del'` | Row tombstone | `strategy: 'field'` |
| a column name | One column's value | `strategy: 'field'` |

The winning state per cell is stored in `_sync_cells`, and the user table is
**materialised** from it (an UPSERT or a DELETE). Cells are the source of truth;
the user table is a cache.

---

## The join must be a semilattice

`resolve()` must be **commutative, associative and idempotent**:

```
join(join(a, b), c) === join(a, join(b, c))
join(a, b) === join(b, a)
join(a, a) === a
```

It must depend **only on the set of operation keys** (their `Ts` triples and
payloads). It must never depend on:

- arrival order,
- the local `siteId` (except as a *tie-breaker over the op's own `s` field*),
- `Date.now()` or any wall clock,
- mutable global state.

If any of these sneak in, two replicas that see the same ops in different orders
will diverge — and because replay is at-least-once, a non-idempotent resolver
will change state when an op is re-applied.

The built-in resolver is simply the max per cell:

```ts
export function joinCells(current, incoming) {
  const out = new Map(current);
  for (const c of incoming) {
    const cur = out.get(c.cell);
    if (!cur || compareTs(c, cur) > 0) out.set(c.cell, { ...c });
  }
  return out;
}
```

`max` over a total order is a semilattice. That is the entire correctness argument.

---

## Built-in strategies

### `strategy: 'row'` (default) — LWW-Register

Each write emits **one** cell `'*'` containing the whole final row image. The
winner is the row with the greatest `Ts`. Concurrent edits to the same row are
resolved by taking one entire row (non-overlapping edits are *not* merged).

- Simple, compact, predictable.
- Deterministic even with identical clocks.
- Highest `p` wins; clock skew between devices therefore decides *which* write
  survives (inherent to LWW), but convergence is unaffected.

### `strategy: 'field'` — per-column LWW

Each write emits **one cell per changed column**, computed from the exact
OLD/NEW row images captured by the triggers (not from a "last pushed" baseline —
that was a real bug found and fixed during development). Concurrent edits to
*different* columns are both preserved.

- A `$del` tombstone beats every cell at or before its `Ts`; a causally-newer
  put resurrects only its own columns.
- A device that has never pushed before emits only the columns it actually
  changed, so it cannot clobber a concurrent edit to another column.

```ts
const engine = createSyncEngine({ ..., strategy: 'field' });
```

All devices **must** use the same strategy (checked via the manifest and the
schema epoch).

### Deletes

Deletes are tombstones, never physical erasures of history. A stale update
cannot resurrect a deleted row. A *causally-later* recreate wins: when device B
pulls A's tombstone, the HLC receive rule folds A's timestamp into B's clock, so
B's subsequent local write necessarily has a greater `Ts`.

---

## HLC (why timestamps are trustworthy enough)

`p` is physical milliseconds (`unixepoch('subsec') * 1000`, or
`strftime('%s','now') * 1000` on older SQLite), `l` is a logical counter, `s` is
the site id.

- **Send rule** (in the trigger, and in `trackChange`):
  `p = max(local.p, now)`, `l = local.p >= now ? local.l + 1 : 0`.
- **Receive rule** (`applyOps`): a pure `max`/join over all received timestamps —
  deliberately **not** an increment, because replay is at-least-once and must be
  idempotent. This still guarantees the next local send is strictly newer than
  everything it has seen.

Ordering is separated from delivery: the HLC only decides LWW conflicts; a
per-site `seq` number drives cursors and contiguous ranges. Clock skew therefore
cannot cause missed pulls.

`clockSkewMs` adds tolerated physical skew when folding received timestamps;
usually leave it at `0`.

---

## Writing a custom resolver

```ts
import {
  cellDecode, cellEncode, compareTs, joinCells,
  type Cell, type CellState, type ConflictResolver,
} from 'sqlite-remote-sync';
```

`ConflictResolver`:

```ts
interface ConflictResolver {
  readonly id: string;   // part of the schema epoch — change it => migrate()
  resolve(ctx: ResolveContext): Map<string, CellState>;
}

interface ResolveContext {
  tbl: string;
  pk: string;
  incoming: readonly Cell[];             // cells offered by this op
  current: ReadonlyMap<string, CellState>; // current winners for this row
  primaryKey: readonly string[];
}
```

Return the **winning cells for every cell name**. Keys absent from the returned
map keep their current value. `materialize()` rebuilds the user row from the
map; primary keys are taken from the op identity (`pk`), so do not try to
"resolve" PK columns.

### Example 1 — keep the highest `rev` (with `strategy: 'field'`)

A valid semilattice: `max` by `(rev value, Ts)` over the candidate set. The
stored `current` is already the previous join result, so this stays
associative/idempotent.

```ts
export const maxRevResolver: ConflictResolver = {
  id: 'max-rev',
  resolve(ctx) {
    const out = joinCells(ctx.current, ctx.incoming); // default LWW for other cells
    const candidates = [...ctx.current.values(), ...ctx.incoming].filter(
      (c) => c.cell === 'rev' && c.value !== null,
    );
    if (!candidates.length) return out;

    let best = candidates[0]!;
    for (const c of candidates) {
      const a = Number(cellDecode(best.value ?? 'null|'));
      const b = Number(cellDecode(c.value ?? 'null|'));
      if (b > a || (b === a && compareTs(c, best) > 0)) best = c;
    }
    out.set('rev', { cell: 'rev', value: best.value, p: best.p, l: best.l, s: best.s });
    return out;
  },
};
```

### Example 2 — add-wins set for a `tags` column

Set union is a semilattice. The accumulated union is stored as the cell value;
the winning `Ts` is still the LWW winner's (so later higher-timestamp writes are
processed correctly).

```ts
export const addWinsTagsResolver: ConflictResolver = {
  id: 'add-wins-tags',
  resolve(ctx) {
    const out = joinCells(ctx.current, ctx.incoming);
    const tags = new Set<string>();
    for (const c of [...ctx.current.values(), ...ctx.incoming]) {
      if (c.cell !== 'tags' || c.value === null) continue;
      for (const t of String(cellDecode(c.value) ?? '').split(',')) {
        if (t.trim()) tags.add(t.trim());
      }
    }
    const winner = out.get('tags');
    if (winner) out.set('tags', { ...winner, value: cellEncode([...tags].sort().join(',')) });
    return out;
  },
};
```

> Caveat: add-wins interacts subtly with `$del` tombstones (data from before a
> deletion can be retained). Test delete/recreate scenarios for your schema, or
> clear the accumulated cell when a `$del` wins.

### Example 3 — prefer a specific site (deterministic bias)

Depending on the **op's own** `s` is allowed — it is part of the op key, so the
result still depends only on the op set. This is a total order:
`(isFavoured, p, l, s)`.

```ts
export function preferSiteResolver(favoured: string): ConflictResolver {
  const beats = (a: Cell | CellState, b: Cell | CellState): boolean => {
    const pa = a.s === favoured ? 1 : 0;
    const pb = b.s === favoured ? 1 : 0;
    if (pa !== pb) return pa > pb;
    return compareTs(a, b) > 0;
  };
  return {
    id: `prefer-${favoured}`,
    resolve(ctx) {
      const out = new Map<string, CellState>(ctx.current);
      for (const c of ctx.incoming) {
        const cur = out.get(c.cell);
        if (!cur || beats(c, cur)) out.set(c.cell, { ...c });
      }
      return out;
    },
  };
}
```

Only use this if you genuinely want one device to always win; otherwise prefer
the unbiased default.

---

## Broken resolvers (do not copy)

```ts
// BROKEN: "last arrival wins" — depends on delivery order.
const broken: ConflictResolver = {
  id: 'broken',
  resolve(ctx) {
    const out = new Map(ctx.current);
    for (const c of ctx.incoming) out.set(c.cell, { ...c });
    return out;
  },
};
```

Replica A receiving `[op1, op2]` and replica B receiving `[op2, op1]` end with
different values. Equally broken:

- `Date.now()` inside `resolve()` (re-applying an op changes the result → not
  idempotent),
- preferring `config.siteId` (local identity differs per replica),
- reading mutable module-level counters or the user table itself,
- dropping `$del` cells (deleted rows can resurrect).

---

## Deploying a resolver

1. `resolver.id` is part of the **schema epoch** = hash of (tables, columns,
   PKs, strategy, resolver id). Manifests carry the epoch.
2. Changing the resolver (or `strategy`) changes the epoch. Deploy the code to
   **all** devices and call `await engine.migrate()` on each before they write
   again; a mismatched device refuses to sync with a clear error.
3. Prefer a deterministic `id` string; avoid embedding timestamps.
4. Custom resolvers work with both strategies, but per-column logic only makes
   sense with `strategy: 'field'` (row strategy has a single `'*'` cell).

---

## Testing your resolver

Minimum convergence checklist (mirrors the library's own tests):

1. Two devices, identical `tables` / `strategy` / `resolver`.
2. Establish a common baseline, then make **concurrent conflicting edits** while
   offline.
3. Deliver the ops in **both orders** (A→B then B→A, and the reverse).
4. Assert `SELECT * ...` dumps are byte-identical on both replicas.
5. Re-apply the same segment twice — state must not change (idempotency).
6. Test delete vs concurrent update, and delete vs causally-later recreate.
7. Test with BLOB / bigint / NULL / text containing `|` if your resolver decodes
   values.

```ts
const engine = createSyncEngine({ ..., resolver: maxRevResolver, strategy: 'field' });
```

See `test/replay.test.ts` and `test/engine.test.ts` for the harness pattern.
