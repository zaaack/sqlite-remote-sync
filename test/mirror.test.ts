import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MemoryBackend } from '../src/remote/memory.js';
import { FsBackend } from '../src/remote/fs.js';
import { WebDavBackend } from '../src/remote/webdav.js';
import { MirrorBackend } from '../src/remote/mirror.js';
import { probeIfMatch } from '../src/remote/backend.js';
import { createSyncEngine } from '../src/core/engine.js';
import { makeDb, rows, SCHEMA_SQL } from './helpers.js';
import type {
  RemoteBackend,
  RemoteGetOptions,
  RemoteGetResult,
  RemoteHead,
  RemotePutOptions,
  RemotePutResult,
  RemoteEntry,
} from '../src/core/types.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A backend that can be taken "offline" to test quorum + read fallback. */
class Flaky implements RemoteBackend {
  fail = false;
  constructor(readonly inner: MemoryBackend) {}
  private check(): void {
    if (this.fail) throw new Error('cloud offline');
  }
  async get(k: string, o?: RemoteGetOptions): Promise<RemoteGetResult> {
    this.check();
    return this.inner.get(k, o);
  }
  async put(k: string, d: Uint8Array, o?: RemotePutOptions): Promise<RemotePutResult> {
    this.check();
    return this.inner.put(k, d, o);
  }
  async list(p: string): Promise<RemoteEntry[]> {
    this.check();
    return this.inner.list(p);
  }
  async head(k: string): Promise<RemoteHead | null> {
    this.check();
    return this.inner.head(k);
  }
  async delete(k: string): Promise<void> {
    this.check();
    return this.inner.delete(k);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function dev(backends: RemoteBackend[], site: string) {
  const db = makeDb();
  for (const stmt of SCHEMA_SQL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.adapter.run(stmt);
  }
  const engine = createSyncEngine({
    db: db.adapter,
    backends,
    appId: 'mirror-app',
    siteId: site,
    tables: [
      { name: 'todos', primaryKey: ['id'] },
      { name: 'notes', primaryKey: ['id'] },
    ],
  });
  await engine.init();
  return { db, engine };
}

describe('MirrorBackend / multi-cloud basics', () => {
  it('broadcasts puts + deletes to every backend and presents as no-CAS', async () => {
    const a = new MemoryBackend();
    const b = new MemoryBackend();
    const mirror = new MirrorBackend([a, b]);

    await mirror.put('app/x.json', bytes('hello'));
    assert.deepEqual(a.raw('app/x.json'), bytes('hello'));
    assert.deepEqual(b.raw('app/x.json'), bytes('hello'));
    assert.equal((await mirror.get('app/x.json')).etag, undefined, 'no ETag exposed');
    assert.equal(await probeIfMatch(mirror, 'app/.probe'), false, 'CAS probe must fail -> no-CAS path');

    // opts.etag / createOnly are intentionally ignored, never forwarded.
    await mirror.put('app/x.json', bytes('again'), { etag: '"bogus"', createOnly: true });
    assert.deepEqual(b.raw('app/x.json'), bytes('again'));

    await mirror.delete('app/x.json');
    assert.equal(a.size(), 0);
    assert.equal(b.size(), 0);
  });

  it('get falls back to the next cloud on 404 or a failing replica', async () => {
    const first = new Flaky(new MemoryBackend());
    const second = new MemoryBackend();
    const mirror = new MirrorBackend([first, second]);

    await second.put('app/only-on-second', bytes('B'));
    assert.deepEqual((await mirror.get('app/only-on-second')).data, bytes('B'));

    await first.inner.put('app/both', bytes('A'));
    await second.put('app/both', bytes('B'));
    assert.deepEqual((await mirror.get('app/both')).data, bytes('A'), 'prefers first replica');
    first.fail = true;
    assert.deepEqual((await mirror.get('app/both')).data, bytes('B'), 'falls back when first is offline');
    await assert.rejects(() => mirror.get('app/missing'), /Not found/);
  });

  it('list() returns the union and tolerates an offline replica', async () => {
    const a = new MemoryBackend();
    const flaky = new Flaky(new MemoryBackend());
    const mirror = new MirrorBackend([a, flaky]);
    await a.put('app/a.json', bytes('a'));
    await flaky.inner.put('app/b.json', bytes('b'));
    assert.deepEqual((await mirror.list('app/')).map((e) => e.key), ['app/a.json', 'app/b.json']);
    flaky.fail = true;
    assert.deepEqual((await mirror.list('app/')).map((e) => e.key), ['app/a.json']);
  });

  it('writeQuorum controls availability vs consistency', async () => {
    const good = new MemoryBackend();
    const offline = new Flaky(new MemoryBackend());
    offline.fail = true;
    const errors: number[] = [];
    const lax = new MirrorBackend([good, offline], {
      writeQuorum: 1,
      onBackendError: (e) => errors.push(e.index),
    });
    await lax.put('app/q', bytes('q'));
    assert.deepEqual(errors, [1], 'the failed replica was reported');
    assert.deepEqual(good.raw('app/q'), bytes('q'));

    const strict = new MirrorBackend([good, offline]); // default 'all'
    await assert.rejects(() => strict.put('app/q2', bytes('q2')), /cloud offline/);
  });

  it('head() falls back and delete() is broadcast', async () => {
    const first = new Flaky(new MemoryBackend());
    const second = new MemoryBackend();
    const mirror = new MirrorBackend([first, second]);
    await second.put('app/h', bytes('h'));
    first.fail = true;
    assert.notEqual(await mirror.head('app/h'), null);
    first.fail = false;
    await mirror.delete('app/h');
    assert.equal(second.size(), 0);
  });

  it('createSyncEngine({ backends }) mirrors to every cloud and converges', async () => {
    const cloudA = new MemoryBackend();
    const cloudB = new MemoryBackend();
    const a = await dev([cloudA, cloudB], 'A');
    const b = await dev([cloudA, cloudB], 'B');

    await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['m1', 'multi-cloud']);
    await a.engine.sync();
    await b.engine.sync();
    assert.deepEqual(rows(b.db, 'todos'), rows(a.db, 'todos'));
    assert.equal(rows(b.db, 'todos')[0]!.title, 'multi-cloud');

    // Both clouds hold the same objects (a device could read from either).
    const keysA = cloudA.keys();
    const keysB = cloudB.keys();
    assert.deepEqual(keysB, keysA, 'both clouds are identical mirrors');
    assert.ok(keysA.some((k) => k.includes('/segments/')));
    assert.ok(keysA.filter((k) => k.includes('/manifest/')).length >= 2);
    await a.engine.close();
    await b.engine.close();
  });

  it('a single-element backends array behaves like a plain backend', async () => {
    const only = new MemoryBackend();
    const a = await dev([only], 'A');
    await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['s1', 'single']);
    await a.engine.sync();
    assert.ok(only.keys().some((k) => k.includes('/segments/')));
    await a.engine.close();
  });
});

describe('multi-cloud E2E over real HTTP + disk', () => {
  const require = createRequire(import.meta.url);
  const webdav = require('webdav-server').v2 as {
    WebDAVServer: new (opts: { port: number; hostname: string }) => {
      start(cb: () => void): void;
      stop(cb: () => void): void;
    };
  };
  let server: InstanceType<typeof webdav.WebDAVServer>;
  let cloudWebDav: WebDavBackend;
  let cloudDisk: FsBackend;
  let tmp: string;

  before(async () => {
    const port = await freePort();
    server = new webdav.WebDAVServer({ port, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.start(() => r()));
    cloudWebDav = new WebDavBackend({ url: `http://127.0.0.1:${port}`, fetch: globalThis.fetch });
    tmp = await mkdtemp(join(tmpdir(), 'srs-mirror-'));
    cloudDisk = new FsBackend(tmp);
  });

  after(async () => {
    await new Promise<void>((r) => server.stop(() => r()));
    await rm(tmp, { recursive: true, force: true });
  });

  it('two heterogeneous clouds stay in sync; a device can read from either', { timeout: 60000 }, async () => {
    const mirror = new MirrorBackend([cloudWebDav, cloudDisk]);
    const a = await dev([mirror], 'A');
    const b = await dev([mirror], 'B');

    await a.db.adapter.run('INSERT INTO todos (id,title) VALUES (?,?)', ['h1', 'over two clouds']);
    await a.db.adapter.run('INSERT INTO notes (id,body,rev) VALUES (?,?,?)', ['n1', 'note', 1]);
    await a.engine.sync();
    await b.engine.sync();
    assert.deepEqual(rows(b.db, 'todos'), rows(a.db, 'todos'));
    assert.deepEqual(rows(b.db, 'notes'), rows(a.db, 'notes'));

    // Both clouds contain the same object keys -> either one is a full backup.
    const keysDav = (await cloudWebDav.list('mirror-app/')).map((e) => e.key).sort();
    const keysDisk = (await cloudDisk.list('mirror-app/')).map((e) => e.key).sort();
    assert.deepEqual(keysDisk, keysDav, 'WebDAV cloud and disk cloud are identical');
    assert.ok(keysDav.some((k) => k.includes('/segments/')));

    // A brand-new device pointed at ONLY the second cloud sees all the data:
    // proves the mirror is a genuine independent replica, not a proxy.
    const solo = await dev([cloudDisk], 'SOLO');
    await solo.engine.pull();
    assert.deepEqual(rows(solo.db, 'todos'), rows(a.db, 'todos'));
    assert.deepEqual(rows(solo.db, 'notes'), rows(a.db, 'notes'));

    await a.engine.close();
    await b.engine.close();
    await solo.engine.close();
  });
});
