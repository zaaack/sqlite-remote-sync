import { base64Decode, base64Encode, fingerprint, utf8Decode, utf8Encode } from './codec.js';
import type { SyncOp } from './types.js';

/**
 * On-disk segment format. A single compact JSON object (gzip-compressed by
 * the engine) rather than one file per operation. Large BLOB cells are stored
 * once per segment in `blobs` and referenced as `blobx|<hash>`, which dedupes
 * repeated attachments without creating extra remote objects.
 */
export interface SegmentFile {
  v: 1;
  blobs?: Record<string, string>;
  ops: SyncOp[];
}

export interface BuiltSegment {
  ops: SyncOp[];
  payload: Uint8Array;
  hash: string;
  from: number;
  to: number;
}

export function encodeSegment(ops: readonly SyncOp[], blobs?: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const file: SegmentFile = { v: 1, ops: ops as SyncOp[] };
  if (blobs?.size) {
    const refs = new Set<string>();
    for (const op of ops) {
      for (const c of op.cells) {
        if (c.value?.startsWith('blobx|')) refs.add(c.value.slice(6));
      }
    }
    if (refs.size) {
      const dict: Record<string, string> = {};
      for (const h of refs) {
        const b = blobs.get(h);
        if (b) dict[h] = base64Encode(b);
      }
      if (Object.keys(dict).length) file.blobs = dict;
    }
  }
  return utf8Encode(JSON.stringify(file));
}

export function decodeSegment(bytes: Uint8Array): { ops: SyncOp[]; blobs: Map<string, Uint8Array> } {
  const file = JSON.parse(utf8Decode(bytes)) as SegmentFile;
  const blobs = new Map<string, Uint8Array>();
  for (const [h, b64] of Object.entries(file.blobs ?? {})) blobs.set(h, base64Decode(b64));
  return { ops: file.ops ?? [], blobs };
}

/**
 * Split ops into bounded chunks. Each chunk carries only the blobs it
 * references, so a large change set becomes a handful of files that can be
 * downloaded in parallel instead of thousands of tiny ones.
 */
export function buildSegments(
  ops: readonly SyncOp[],
  blobs: ReadonlyMap<string, Uint8Array>,
  maxBytes: number,
  maxOps: number,
): BuiltSegment[] {
  const out: BuiltSegment[] = [];
  let chunk: SyncOp[] = [];
  let size = 2; // JSON overhead

  const flush = (): void => {
    if (!chunk.length) return;
    const payload = encodeSegment(chunk, blobs);
    out.push({
      ops: chunk,
      payload,
      hash: fingerprint(payload),
      from: chunk[0]!.seq,
      to: chunk[chunk.length - 1]!.seq,
    });
    chunk = [];
    size = 2;
  };

  for (const op of ops) {
    const approx = JSON.stringify(op).length + 1;
    if (chunk.length && (chunk.length >= maxOps || size + approx > maxBytes)) flush();
    chunk.push(op);
    size += approx;
  }
  flush();
  return out;
}
