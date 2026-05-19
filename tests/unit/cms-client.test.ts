import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkCache } from '../../packages/cms-client/src/cache.js';
import { createClient, CmsClientError } from '../../packages/cms-client/src/index.js';

test('SdkCache stores + retrieves with etag', () => {
  const c = new SdkCache(10);
  c.set('k', { v: 1 }, ['content:1'], '"e"');
  const hit = c.get<{ v: number }>('k');
  assert.deepEqual(hit, { value: { v: 1 }, etag: '"e"' });
  assert.equal(c.get('missing'), undefined);
});

test('SdkCache invalidate exact + prefix', () => {
  const c = new SdkCache(10);
  c.set('a', 1, ['content:5']);
  c.set('b', 2, ['type-list:post:en']);
  c.set('cc', 3, ['type-list:post:de']);
  assert.equal(c.invalidate(['content:5']), 1);
  assert.equal(c.get('a'), undefined);
  // prefix: invalidating 'type-list:post' clears :en and :de
  assert.equal(c.invalidate(['type-list:post']), 2);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('cc'), undefined);
});

test('SdkCache LRU eviction', () => {
  const c = new SdkCache(2);
  c.set('a', 1, []);
  c.set('b', 2, []);
  c.set('cc', 3, []); // evicts 'a'
  assert.equal(c.get('a'), undefined);
  assert.equal(c.size().entries, 2);
});

test('createClient builds base URL + cache stats', () => {
  const cms = createClient({ url: 'https://cms.example.com/', cache: 'auto' });
  assert.deepEqual(cms.cacheStats(), { entries: 0, depKeys: 0 });
});

test('client surfaces API errors as CmsClientError', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'notFound', message: 'nope' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  const cms = createClient({ url: 'http://x', fetch: fakeFetch });
  await assert.rejects(
    () => cms.content.bySlug('post', 'missing'),
    (e: unknown) => e instanceof CmsClientError && (e as CmsClientError).status === 404 && (e as CmsClientError).code === 'notFound',
  );
});

test('client auto-cache returns hit without second fetch', async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ data: { id: 1, title: 'X' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Surrogate-Key': 'content:1' },
    });
  }) as unknown as typeof fetch;
  const cms = createClient({ url: 'http://x', cache: 'auto', fetch: fakeFetch });
  await cms.content.bySlug('post', 'a', { locale: 'en' });
  await cms.content.bySlug('post', 'a', { locale: 'en' });
  assert.equal(calls, 1, 'second call served from cache');
  // webhook-style invalidation forces a refetch
  cms.invalidate(['content:1']);
  await cms.content.bySlug('post', 'a', { locale: 'en' });
  assert.equal(calls, 2);
});
