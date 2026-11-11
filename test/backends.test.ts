import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareTs, foldBatch, hlcReceive, hlcSend } from '../src/core/clock.js';
import { CasConflictError } from '../src/core/types.js';
import { GenericHttpBackend } from '../src/remote/http.js';
import { FsBackend } from '../src/remote/fs.js';
import { MemoryBackend } from '../src/remote/memory.js';
import {
  createLayout,
  parseSegmentName,
  updateManifest,
  vvAtLeast,
  type SiteManifest,
} from '../src/remote/manifest.js';

function manifest(site: string, segments: SiteManifest['segments'] = []): SiteManifest {
  return {
    v: 0,
    site,
    epoch: 'e',
    resolver: 'lww',
    strategy: 'row',
    codec: 'identity',
    segments,
    lastSeq: 0,
    applied: {},
  };
}

describe('clock', () => {
  it('send rule is monotonic within the same millisecond', () => {
    let clock = { p: 0, l: 0 };
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = hlcSend(clock, 1000, 'A');
      clock = r.clock;
      seen.push(`${r.ts.p}:${r.ts.l}`);
    }
    assert.equal(new Set(seen).size, 5);
    assert.deepEqual(clock, { p: 1000, l: 4 });
  });

  it('receive rule is an idempotent max/join and orders later sends', () => {
    const local = { p: 100, l: 1 };
    const remote = { p: 900, l: 7 };
    const a = hlcReceive(local, remote, 1000);
    const b = hlcReceive(a, remote, 1000);
    assert.deepEqual(a, b, 're-applying an op does not change the clock');
    const next = hlcSend(a, 1000, 'A');
    assert.ok(compareTs(next.ts, { p: 900, l: 7, s: 'ZZZ' }) > 0);
    assert.equal(foldBatch({ p: 0, l: 0 }, [{ p: 5, l: 2 }, { p: 9, l: 1 }], 10).p, 10);
  });
});

describe('MemoryBackend', () => {
  it('supports ETag, If-Match, 304, Range and list', async () => {
    const b = new MemoryBackend();
    const put = await b.put('a/x.json', new Uint8Array([1, 2, 3, 4]));
    assert.ok(put.etag);

    const g = await b.get('a/x.json');
    assert.deepEqual(g.data, new Uint8Array([1, 2, 3, 4]));

    const nm = await b.get('a/x.json', { etag: put.etag });
    assert.equal(nm.notModified, true);

    const range = await b.get('a/x.json', { range: 'bytes=1-2' });
    assert.deepEqual(range.data, new Uint8Array([2, 3]));
    assert.equal(range.totalSize, 4);

    await assert.rejects(() => b.put('a/x.json', new Uint8Array([9]), { etag: '"wrong"' }), CasConflictError);
    const ok = await b.put('a/x.json', new Uint8Array([9]), { etag: put.etag });
    assert.notEqual(ok.etag, put.etag);

    assert.deepEqual((await b.list('a/')).map((e) => e.key), ['a/x.json']);
    await b.delete('a/x.json');
    assert.equal(await b.head('a/x.json'), null);
  });
});

describe('FsBackend', () => {
  it('round-trips files with content-fingerprint ETags and CAS', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'srs-fs-'));
    try {
      const b = new FsBackend(dir);
      const put = await b.put('app/manifest/A.json', new Uint8Array([1, 2, 3]));
      assert.ok(put.etag);
      assert.deepEqual((await b.get('app/manifest/A.json')).data, new Uint8Array([1, 2, 3]));
      await assert.rejects(
        () => b.put('app/manifest/A.json', new Uint8Array([4]), { etag: '"fp-nope"' }),
        CasConflictError,
      );
      assert.deepEqual((await b.list('app/')).map((e) => e.key), ['app/manifest/A.json']);
      await b.delete('app/manifest/A.json');
      assert.equal(await b.head('app/manifest/A.json'), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('GenericHttpBackend', () => {
  it('maps the REST/ETag contract through fetch', async () => {
    const store = new Map<string, Uint8Array>();
    let version = 0;
    const etags = new Map<string, string>();
    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const key = decodeURIComponent(url.pathname.slice('/api/'.length));
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const etag = etags.get(key);
      if (url.searchParams.has('list')) {
        return new Response(
          JSON.stringify([...store.keys()].filter((k) => k.startsWith(key)).map((k) => ({ key: k, etag: etags.get(k) }))),
          { status: 200 },
        );
      }
      if (method === 'GET') {
        if (!store.has(key)) return new Response('', { status: 404 });
        if (headers.get('if-none-match') && headers.get('if-none-match') === etag) {
          // `new Response(..., {status:304})` is rejected by undici; return a
          // minimal stand-in since GenericHttpBackend only reads `status`.
          return { status: 304, ok: false, headers: new Headers() } as unknown as Response;
        }
        return new Response(store.get(key) as BodyInit, { status: 200, headers: { ETag: etag! } });
      }
      if (method === 'PUT') {
        if (headers.get('if-match') && headers.get('if-match') !== etag) return new Response('', { status: 412 });
        const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        store.set(key, body);
        const e = `"v${++version}"`;
        etags.set(key, e);
        return new Response('', { status: 200, headers: { ETag: e } });
      }
      if (method === 'HEAD') {
        if (!store.has(key)) return new Response('', { status: 404 });
        return new Response('', { status: 200, headers: { ETag: etag!, 'Content-Length': String(store.get(key)!.length) } });
      }
      if (method === 'DELETE') {
        store.delete(key);
        etags.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response('', { status: 405 });
    };

    const b = new GenericHttpBackend({ baseUrl: 'http://local/api', fetch: mockFetch as typeof fetch });
    const put = await b.put('app/x', new Uint8Array([7, 8]));
    assert.ok(put.etag);
    assert.deepEqual((await b.get('app/x')).data, new Uint8Array([7, 8]));
    assert.equal((await b.get('app/x', { etag: put.etag })).notModified, true);
    assert.deepEqual((await b.list('app/')).map((e) => e.key), ['app/x']);
    assert.ok((await b.head('app/x'))?.size === 2);
    await assert.rejects(() => b.put('app/x', new Uint8Array([1]), { etag: '"bad"' }), CasConflictError);
    await b.delete('app/x');
    assert.equal(await b.head('app/x'), null);
  });
});

describe('manifest', () => {
  it('layout and segment name parsing', () => {
    const l = createLayout('my app');
    assert.equal(l.manifestKey('a/b'), 'my app/manifest/a%2Fb.json');
    const key = l.segmentKey('a/b', 3, 9, 'deadbeef');
    assert.deepEqual(parseSegmentName(key), { from: 3, to: 9, hash: 'deadbeef' });
  });

  it('vvAtLeast', () => {
    assert.equal(vvAtLeast({ A: 5, B: 2 }, { A: 4 }), true);
    assert.equal(vvAtLeast({ A: 3 }, { A: 4, B: 0 }), false);
  });

  it('CAS re-base keeps another writer descriptors on 412', async () => {
    const backend = new MemoryBackend();
    const key = createLayout('t').manifestKey('A');
    const d1 = { from: 1, to: 2, key: 's/1-2-aaa.seg', bytes: 1, hash: 'aaa' };
    const d2 = { from: 3, to: 4, key: 's/3-4-bbb.seg', bytes: 1, hash: 'bbb' };
    await Promise.all([
      updateManifest(backend, key, (cur) => ({ ...(cur ?? manifest('A')), segments: [...(cur?.segments ?? []), d1] }), true),
      updateManifest(backend, key, (cur) => ({ ...(cur ?? manifest('A')), segments: [...(cur?.segments ?? []), d2] }), true),
    ]);
    const final = await updateManifest(backend, key, (cur) => cur ?? manifest('A'), true);
    assert.equal(final.segments.length, 2, 'both descriptors survived');
    assert.ok(final.segments.some((d) => d.hash === 'aaa'));
    assert.ok(final.segments.some((d) => d.hash === 'bbb'));
  });
});
