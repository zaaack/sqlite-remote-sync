import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebDavBackend, parsePropfind } from '../src/remote/webdav.js';
import { probeIfMatch } from '../src/remote/backend.js';
import { makeDevice, rows, type Device } from './helpers.js';

const require = createRequire(import.meta.url);
// webdav-server is CommonJS; loaded through createRequire.
const webdav = require('webdav-server').v2 as {
  WebDAVServer: new (opts: { port: number; hostname: string }) => {
    start(cb: () => void): void;
    stop(cb: () => void): void;
  };
};

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

describe('WebDavBackend against a real webdav-server', () => {
  let server: InstanceType<typeof webdav.WebDAVServer>;
  let backend: WebDavBackend;
  let baseUrl: string;
  const devices: Device[] = [];

  before(async () => {
    const port = await freePort();
    server = new webdav.WebDAVServer({ port, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.start(() => r()));
    baseUrl = `http://127.0.0.1:${port}`;
    backend = new WebDavBackend({ url: baseUrl, fetch: globalThis.fetch });
  });

  after(async () => {
    for (const d of devices) await d.engine.close();
    await new Promise<void>((r) => server.stop(() => r()));
  });

  it('detects that webdav-server ignores If-Match (CAS unavailable)', async () => {
    assert.equal(await probeIfMatch(backend, 'test-app/.cas-probe'), false);
  });

  it('parsePropfind handles namespace-prefixed and absolute hrefs', () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
      <D:response><D:href>http://host/dav/app/manifest/</D:href>
        <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
      <D:response><d:href xmlns:d="DAV:">/dav/app/manifest/A.json</d:href>
        <d:propstat><d:prop><d:getetag>"abc"</d:getetag><d:getcontentlength>42</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></D:response>
    </D:multistatus>`;
    const children = parsePropfind(xml, '/dav/');
    assert.equal(children.length, 2);
    assert.equal(children[0]!.isDir, true);
    assert.equal(children[1]!.key, 'app/manifest/A.json');
    assert.equal(children[1]!.etag, '"abc"');
    assert.equal(children[1]!.size, 42);
  });

  it('two devices sync bidirectionally over real WebDAV (MKCOL/PUT/PROPFIND)', async () => {
    const a = await makeDevice(backend, 'A', { healInterval: 1 });
    const b = await makeDevice(backend, 'B', { healInterval: 1 });
    devices.push(a, b);

    await a.db.adapter.run('INSERT INTO todos (id, title, done) VALUES (?, ?, ?)', ['w1', 'over webdav', 1]);
    const push = await a.engine.sync();
    assert.ok(push.pushedSegments >= 1);

    const pull = await b.engine.sync();
    assert.ok(pull.pulledSegments >= 1);
    assert.deepEqual(rows(b.db, 'todos'), [
      { id: 'w1', title: 'over webdav', done: 1, score: null, payload: null },
    ]);

    await b.db.adapter.run('UPDATE todos SET title = ? WHERE id = ?', ['back from B', 'w1']);
    await b.engine.sync();
    await a.engine.sync();
    assert.deepEqual(rows(a.db, 'todos'), rows(b.db, 'todos'));
    assert.equal(rows(a.db, 'todos')[0]!.title, 'back from B');
  });

  it('keeps the WebDAV object count small after many writes', async () => {
    const a = await makeDevice(backend, 'A2', { segmentMaxOps: 40, healInterval: 1 });
    devices.push(a);
    for (let i = 0; i < 120; i++) {
      await a.db.adapter.run('INSERT INTO todos (id, title) VALUES (?, ?)', [`w-${i}`, `v${i}`]);
    }
    await a.engine.sync();
    const all = await backend.list('test-app/');
    // 120 writes => a handful of segments + 1 manifest, not 120 files.
    assert.ok(all.length < 20, `too many WebDAV objects: ${all.length}`);
  });
});
