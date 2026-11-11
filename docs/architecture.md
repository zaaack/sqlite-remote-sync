# Architecture

> [← Docs index](./README.md)

This document describes the sync protocol in detail: what is stored locally,
what is stored remotely, and how push/pull/compaction maintain convergence and
crash safety.

---

## Design constraints

| Constraint | Consequence |
| --- | --- |
| Works on OPFS / wa-sqlite / RN / Capacitor / Tauri, where `.db` file bytes are not portable | Snapshots must be **logical SQL**, never raw DB files |
| Zero runtime dependencies, one code path | Core depends only on `SqliteAdapter` (raw SQL) + `RemoteBackend` (byte objects) |
| WebDAV has expensive per-file requests | Coalesce writes, chunk large pushes, compact periodically |
| Devices are offline and clocks are skewed | CRDT-style join + HLC, not "last uploader wins" |
| No server-side logic / coordination | Immutable, content-addressed segments + one manifest per site |

---

## Local state (`_sync_*` tables)

`init()` creates these inside the **user's** database (one transaction, idempotent):

| Table | Purpose |
| --- | --- |
| `_sync_meta` | key/value: `site`, `schema_epoch`, `trigger_hash`, `last_pushed_seq`, `applied_snapshot` |
| `_sync_clock` | single row `(p, l)` — the local HLC |
| `_sync_oplog` | outbox: `seq, tbl, pk, op, row, old_row, p, l, site` (AUTOINCREMENT) |
| `_sync_cells` | LWW-Map state: `(tbl, pk, cell) → value, p, l, s` |
| `_sync_cursors` | per-site applied sequence (version vector) |
| `_sync_replay` | per-PK replay guard, populated/cleared inside the apply transaction |
| `_sync_blobs` | content-addressed BLOBs (`hash → data`) |
| `_sync_ctrl` | reserved control row |

### Trigger capture

For every synced table, four triggers are generated: `AFTER INSERT`, `AFTER
UPDATE` (same PK), `AFTER UPDATE` (PK changed → delete old + put new), `AFTER
DELETE`. Each trigger:

1. Checks the replay guard: `NOT EXISTS (SELECT 1 FROM _sync_replay WHERE tbl=? AND pk=?)`.
2. Advances the HLC in SQL:
   ```sql
   UPDATE _sync_clock SET
     l = CASE WHEN p >= (now_expr) THEN l + 1 ELSE 0 END,
     p = MAX(p, (now_expr))
   WHERE id = 1;
   ```
   `now_expr` is `CAST(unixepoch('subsec')*1000 AS INTEGER)` when available.
3. Appends one outbox row with `json_object(...)` of every replicated column,
   encoded as `"<typeof>|<payload>"` (`hex()` for BLOBs, exact decimal text for
   64-bit integers, `CAST(x AS TEXT)` for REAL/TEXT). Splitting on the **first**
   `|` keeps text containing `|` intact. UPDATE triggers also capture the OLD
   row, so field-level diffs are exact.

> SQLite **forbids** main-table triggers from referencing `temp` or attached
> databases (verified experimentally). A connection-local flag is therefore not
> portable; the guard is a real table in the same database, inserted and cleared
> inside the apply transaction — a crash rolls it back, so it can never stick.
> Writes to *unrelated* rows are still captured during replay.

Trigger SQL is hashed; `installSchema()` rebuilds triggers whenever the schema,
strategy or resolver changes, and clears the guard defensively.

---

## From outbox to ops

`buildOpsFromOutbox()` coalesces all pending outbox rows per `(table, pk)`:

- One `SyncOp` per row, carrying the **final** row image and the **max HLC** of
  the coalesced writes. Retrying a push therefore produces byte-identical
  segments (the source is the immutable outbox, not the mutable user table).
- `strategy: 'row'` → one `'*'` cell.
- `strategy: 'field'` → one cell per column whose OLD→NEW value actually
  changed (including a change later reverted), plus `$del` for deletes.
- Large BLOBs beyond `blobThreshold` are externalised as `blobx|<hash>` and
  stored once per segment.

Ops are sorted by `seq` and split into segments by `segmentMaxOps` /
`segmentMaxBytes`.

---

## Wire format

A segment is one compact JSON object, gzip-compressed by `createGzipCodec()`
(`CompressionStream`; falls back to identity when unavailable):

```json
{
  "v": 1,
  "blobs": { "<hash>": "<base64>" },
  "ops": [
    {
      "site": "A", "seq": 12, "tbl": "todos", "pk": "[\"text|t1\"]",
      "cells": [{ "cell": "*", "value": "{\"id\":\"text|t1\", ...}", "p": 1794354955733, "l": 0, "s": "A" }]
    }
  ]
}
```

Names are deterministic: `segments/<site>/<from>-<to>-<fingerprint>.seg`.
Immutable + content-addressed → a retry PUTs byte-identical bytes; there is no
write contention between devices.

---

## Remote layout

```
<appId>/
  manifest/<site>.json                     # v, site, epoch, resolver, strategy, codec,
                                          # segments[], lastSeq, applied{}
  segments/<site>/<from>-<to>-<hash>.seg  # immutable gzip JSON
  snapshots/<hash>.snap                   # full _sync_cells dump + vv
  snapshot.json                           # shared pointer { key, vv, epoch, ... }
```

**One manifest per site, written only by that site.** This is the key to
coordination-free sync: no two devices ever write the same mutable object.
`applied{}` is the site's version vector, published for `gc()`.

---

## Push

1. `ingestLocal()` folds pending outbox entries into `_sync_cells` (so local
   writes are visible to the join before remote ops can win).
2. Build ops → split into segments → upload in bounded parallelism.
3. `updateManifest()` read-modify-writes **our own** manifest, adding the new
   segment descriptors (deduplicated by key) and publishing `applied{}`.
   - With CAS: `If-Match` with the ETag from `get`; on 412 **re-base** (re-read
     and re-apply the mutation), never blind-retry a stale body.
   - Without CAS: read, mutate, unconditional PUT — safe because of per-site
     ownership.
   - Segments covered by the current snapshot pointer are dropped from the
     descriptor list.
4. `last_pushed_seq` is written **only after** the manifest is durable. The
   outbox survives a crash, so a re-push reproduces the exact same bytes.
5. Optional auto-compact when the segment count crosses `compactAfterSegments`.

---

## Pull

1. `ingestLocal()` (same as push, idempotent).
2. Discover sites via `list(manifest/)`, plus `list(segments/)` every
   `healInterval` cycles to heal orphaned segments (a client that died after
   PUT but before the manifest update) and manifest updates lost on no-CAS
   backends.
3. **Snapshot bootstrap**: if `snapshot.json` is newer than our cursors and not
   yet applied, download the snapshot, convert its cells into ops and set the
   version vector. Fresh devices get the full state in one object.
4. For each site, select only segments with `to > cursor[site]` (union of
   manifest descriptors + discovered files), sorted by `from`.
5. Download in bounded parallelism (`concurrency`), **all network I/O before
   the transaction**. A 404 is tolerated (a concurrent compaction may have
   GC'd a segment already covered by the snapshot); processing stops at the
   first gap **per site** so the cursor never skips missing data.
6. **One transaction** (`applyOps`) commits everything atomically:
   - persist externalised blobs,
   - insert the replay guard rows,
   - bulk-load current cells,
   - resolve via the semilattice join and write changed cells,
   - materialise user rows (UPSERT / DELETE),
   - clear the replay guard,
   - fold received timestamps into the HLC (pure max/join → idempotent),
   - advance cursors and the `applied_snapshot` marker.
7. Publish the applied version vector (`ackApplied`) for `gc()`.

Replay is **at-least-once and fully idempotent**: the LWW join plus
timestamp-guarded cell writes make re-applying an op a no-op.

---

## Conflict join

See [Conflict resolution](./conflict-resolution.md). In short: for each cell the
winner is the candidate with the greatest `(p, l, s)`. The operation is
commutative, associative and idempotent, so every replica converges regardless
of delivery order or clock skew.

`materialize()` (field strategy) filters cells strictly newer than the `$del`
tombstone, then UPSERTs only the surviving columns, taking primary keys from the
op identity.

---

<a id="compaction-and-gc"></a>

## Compaction and gc

`compact()`:

1. `ingestLocal()` so local ops are included.
2. Build a **logical snapshot**: full `_sync_cells` dump + version vector +
   referenced blobs → immutable `snapshots/<hash>.snap`.
3. Advance `snapshot.json` via CAS re-base (monotonic: a candidate whose `vv`
   is not ≥ the current pointer's `vv` is rejected — no data loss, the next
   compaction wins).
4. `rollupOwnSegments()`: merge this site's segments into one, update our
   manifest, then delete the superseded files. A peer mid-download gets a 404,
   which pull tolerates.
5. Keep at most **2** snapshot objects (current + immediate predecessor, for a
   peer still downloading the old one).

`gc()`:

- Safe watermark = the snapshot pointer's `vv` for our site, lowered by any
  peer's `applied[ourSite]` ack. A replica behind the snapshot bootstraps from
  it (which advances its cursor to `vv`), so it never needs the covered
  segments.
- Remove covered descriptors from our manifest **first**, then delete files.
- Only our own prefix is touched — each site owns and GCs its own segments.

Verified: after 500 individual pushes, `compact()` + `gc()` reduces the object
count to ~4, and a brand-new device still reads all 500 rows from the snapshot.

---

## Failure modes & graceful degradation

| Condition | Behaviour |
| --- | --- |
| Crash mid-push | Outbox intact → retry PUTs byte-identical segments |
| Crash mid-pull transaction | Everything rolls back (cells + rows + clock + cursors + guard) → replay is idempotent |
| Crash after manifest PUT, before `last_pushed_seq` | Re-push reproduces identical segment names and bytes |
| Server ignores `If-Match` / no ETag | `probeIfMatch` → no-CAS path: per-site manifests + list/union healing |
| Segment 404 during pull | Tolerated; per-site cursor stops at the gap; snapshot bootstrap heals |
| Concurrent compaction | Snapshot pointer re-base + 404 tolerance; no lost updates |
| Old SQLite (< 3.42) | `strftime('%s','now')*1000` fallback (coarser, still correct) |
| No triggers | `engine.trackChange(table, pkValues)` explicit capture |
| No `CompressionStream` | Identity codec (larger objects, same correctness) |
| Mirror / files-sdk backend | Deliberately no CAS/304; no-CAS path used |

---

## Performance characteristics

- **Delta-only**: only segments beyond each site's cursor are downloaded.
- **Coalescing**: N local writes to one row → 1 op; one push cycle → 1 segment
  (unless chunked).
- **Batched replay**: bulk cell loads, chunked multi-row `INSERT ... ON
  CONFLICT`, one transaction.
- **Parallel downloads** with bounded `concurrency`.
- **Snapshot bootstrap** instead of replaying all history.
- **Content-addressed blobs** dedupe large values without extra remote objects.
- Measured on a real `webdav-server`: 500 rows / 5 tables → 2 objects, ~11 KB
  gzip; a no-op `sync()` costs 2 requests. See the [README](../README.md#verified-against-a-real-webdav-server).

---

## Known limitations

- Requires a **stable primary key**; PK mutation is emitted as delete+insert but
  should not be a normal workflow.
- LWW means non-overlapping concurrent edits to the *same column* (or to the
  whole row in `row` strategy) are not merged — use `strategy: 'field'` or a
  custom resolver.
- Wall-clock skew affects *which* LWW write wins, not convergence.
- All devices must share `tables`, `strategy`, `resolver` and codec.
- No-CAS backends re-download manifests every pull; mirrors and `files-sdk`
  backends are always no-CAS.
- `list()` recursion is capped at depth 8 (far beyond this layout's 3–4 levels).
