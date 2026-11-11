import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FilesSdkBackend } from '../src/remote/files-sdk.js';
import type {
  FilesSdkLike,
  FilesSdkListOptions,
  FilesSdkListResult,
  FilesSdkStored,
  FilesSdkUploadOptions,
  FilesSdkDownloadOptions,
  FilesSdkMeta,
} from '../src/remote/files-sdk.js';
import { probeIfMatch } from '../src/remote/backend.js';
import { createSyncEngine } from '../src/core/engine.js';
import { makeDb, rows, SCHEMA_SQL } from './helpers.js';

/** Mirrors files-sdk's API shape (FilesError.code, StoredFile, paged list). */
function filesError(code: string): Error {
  const e = new Error(`files-sdk: ${code}`) as Error & { code: string };
  e.name = 'FilesError';
  e.code = code;
  return e;
}

class FakeFiles implements FilesSdkLike {
  readonly store = new Map<string, { data: Uint8Array; etag: string; size: number }>();
  /** Small page size forces the backend to walk multiple list() cursors. */
  pageSize = 2;
  private version = 0;

  async upload(key: string, body: Uint8Array, _opts?: FilesSdkUploadOptions): Promise<FilesSdkMeta> {
    const etag = `e${++this.version}`;
    this.store.set(key, { data: new Uint8Array(body), etag, size: body.byteLength });
    return { etag, size: body.byteLength };
  }

  async download(key: string, opts?: FilesSdkDownloadOptions): Promise<FilesSdkStored> {
    const f = this.store.get(key);
    if (!f) throw filesError('NotFound');
    let data = f.data;
    if (opts?.range) {
      const end = opts.range.end === undefined ? undefined : opts.range.end + 1; // inclusive
      data = data.slice(opts.range.start, end);
    }
    const copy = new Uint8Array(data);
    return {
      etag: f.etag,
      size: copy.byteLength,
      arrayBuffer: async () => copy.buffer,
    };
  }

  async head(key: string): Promise<FilesSdkMeta> {
    const f = this.store.get(key);
    if (!f) throw filesError('NotFound');
    return { etag: f.etag, size: f.size };
  }

  async list(opts: FilesSdkListOptions = {}): Promise<FilesSdkListResult> {
    const prefix = opts.prefix ?? '';
    const all = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const items = all.slice(start, start + this.pageSize).map((k) => {
      const f = this.store.get(k)!;
      return { key: k, etag: f.etag, size: f.size };
    });
    const next = start + this.pageSize;
    return { items, ...(next < all.length ? { cursor: String(next) } : {}) };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('FilesSdkBackend (structural files-sdk adapter)', () => {
  it('round-trips get/put/head/list/delete and maps NotFound', async () => {
    const files = new FakeFiles();
    const b = new FilesSdkBackend({ files });

    await b.put('app/manifest/A.json', bytes('{"v":1}'), { contentType: 'application/json' });
    assert.equal(decode((await b.get('app/manifest/A.json')).data), '{"v":1}');
    assert.deepEqual(await b.head('app/manifest/A.json'), { size: 7 });
    assert.deepEqual((await b.list('app/')).map((e) => e.key), ['app/manifest/A.json']);
    assert.equal(await b.head('app/missing.json'), null);
    await assert.rejects(() => b.get('app/missing.json'), { name: 'NotFoundError' });
    await b.delete('app/manifest/A.json');
    await b.delete('app/manifest/A.json'); // idempotent
    assert.deepEqual(await b.list('app/'), []);
  });

  it('supports byte-range reads (inclusive end)', async () => {
    const b = new FilesSdkBackend({ files: new FakeFiles() });
    await b.put('app/x', bytes('abcdef'));
    assert.equal(decode((await b.get('app/x', { range: 'bytes=1-3' })).data), 'bcd');
    assert.equal(decode((await b.get('app/x', { range: 'bytes=4-' })).data), 'ef');
  });

  it('walks every list() page via cursors', async () => {
    const files = new FakeFiles();
    const b = new FilesSdkBackend({ files });
    for (let i = 0; i < 5; i++) await b.put(`app/segments/A/${i}.seg`, bytes(`x${i}`));
    const keys = (await b.list('app/segments/A/')).map((e) => e.key);
    assert.equal(keys.length, 5, `all pages collected, got ${keys.length}`);
    assert.deepEqual(keys, [0, 1, 2, 3, 4].map((i) => `app/segments/A/${i}.seg`));
  });

  it('is deliberately no-CAS: probe fails and etag/createOnly are ignored', async () => {
    const files = new FakeFiles();
    const b = new FilesSdkBackend({ files });
    assert.equal(await probeIfMatch(b, 'app/.probe'), false);
    assert.equal(files.store.has('app/.probe'), false, 'probe object cleaned up');
    // Conditional options are ignored: every upload is unconditional.
    await b.put('app/x', bytes('one'), { etag: '"bogus"' });
    await b.put('app/x', bytes('two'), { createOnly: true });
    assert.equal(decode((await b.get('app/x')).data), 'two');
  });

  it('full bidirectional sync works through a files-sdk backend', async () => {
    const files = new FakeFiles();
    const backend = new FilesSdkBackend({ files });

    const mk = async (site: string) => {
      const db = makeDb();
      for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
        await db.adapter.run(stmt);
      }
      const engine = createSyncEngine({
        db: db.adapter,
        backend,
        appId: 'fsdk-app',
        siteId: site,
        tables: [
          { name: 'todos', primaryKey: ['id'] },
          { name: 'notes', primaryKey: ['id'] },
        ],
      });
      await engine.init();
      return { db, engine };
    };

    const a = await mk('A');
    const b = await mk('B');
    await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['f1', 'via files-sdk']);
    await a.engine.sync();
    await b.engine.sync();
    assert.deepEqual(rows(b.db, 'todos'), rows(a.db, 'todos'));
    assert.equal(rows(b.db, 'todos')[0]!.title, 'via files-sdk');

    // B's edit travels back to A.
    await b.db.adapter.run('UPDATE todos SET title = ? WHERE id = ?', ['edited on B', 'f1']);
    await b.engine.sync();
    await a.engine.sync();
    assert.equal(rows(a.db, 'todos')[0]!.title, 'edited on B');

    assert.ok([...files.store.keys()].some((k) => k.includes('/segments/')));
    await a.engine.close();
    await b.engine.close();
  });
});
