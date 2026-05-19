import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruMap } from '../../src/cache/lru.js';
import {
  cacheSet,
  cacheGet,
  invalidate,
  flushAll,
  DepCollector,
} from '../../src/cache/deps.js';
import { computeEtag, ifNoneMatchHits } from '../../src/cache/etag.js';

test('LruMap evicts oldest beyond capacity', () => {
  const m = new LruMap<string, number>(3);
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3);
  m.set('d', 4); // evicts 'a'
  assert.equal(m.has('a'), false);
  assert.equal(m.size, 3);
  assert.equal(m.get('d'), 4);
});

test('LruMap get bumps recency', () => {
  const m = new LruMap<string, number>(3);
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3);
  m.get('a'); // 'a' now most-recent
  m.set('d', 4); // evicts 'b' (oldest), not 'a'
  assert.equal(m.has('a'), true);
  assert.equal(m.has('b'), false);
});

test('dep graph invalidates exact dep key', () => {
  flushAll();
  const e = {
    status: 200,
    bodyBytes: new Uint8Array([1]),
    contentType: 'application/json',
    etag: '"x"',
    deps: ['content:42', 'type-list:post:en'],
    storedAt: Date.now(),
  };
  cacheSet('GET:/p1', e);
  assert.ok(cacheGet('GET:/p1'));
  const removed = invalidate(['content:42']);
  assert.equal(removed, 1);
  assert.equal(cacheGet('GET:/p1'), undefined);
});

test('dep graph prefix invalidation', () => {
  flushAll();
  const mk = (deps: string[]) => ({
    status: 200,
    bodyBytes: new Uint8Array(),
    contentType: 'application/json',
    etag: '"y"',
    deps,
    storedAt: Date.now(),
  });
  cacheSet('GET:/a', mk(['type-list:post:en']));
  cacheSet('GET:/b', mk(['type-list:post:de']));
  cacheSet('GET:/c', mk(['type-list:page:en']));
  const n = invalidate(['type-list:post'], { prefix: true });
  assert.equal(n, 2);
  assert.equal(cacheGet('GET:/a'), undefined);
  assert.equal(cacheGet('GET:/b'), undefined);
  assert.ok(cacheGet('GET:/c'));
});

test('DepCollector builds canonical keys', () => {
  const d = new DepCollector();
  d.addContent(7);
  d.addTypeList('post', 'en');
  d.addSetting('site.name');
  d.addMenu('main', 'de');
  const list = d.list().sort();
  assert.deepEqual(list, ['content:7', 'menu:main:de', 'setting:site.name', 'type-list:post:en']);
});

test('computeEtag stable + ifNoneMatch matching', async () => {
  const a = await computeEtag('hello');
  const b = await computeEtag('hello');
  const c = await computeEtag('world');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(ifNoneMatchHits(a, a), true);
  assert.equal(ifNoneMatchHits('*', a), true);
  assert.equal(ifNoneMatchHits(`${c}, ${a}`, a), true);
  assert.equal(ifNoneMatchHits(null, a), false);
  assert.equal(ifNoneMatchHits(c, a), false);
});
