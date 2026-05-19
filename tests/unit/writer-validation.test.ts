import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSlug, validateSeoForPublish } from '../../src/content/writer.js';

test('isValidSlug accepts url-safe slugs', () => {
  assert.equal(isValidSlug('hello-world'), true);
  assert.equal(isValidSlug('a'), true);
  assert.equal(isValidSlug('post-123'), true);
});

test('isValidSlug rejects bad slugs', () => {
  assert.equal(isValidSlug(''), false);
  assert.equal(isValidSlug('Hello'), false, 'uppercase');
  assert.equal(isValidSlug('-leading'), false);
  assert.equal(isValidSlug('trailing-'), false);
  assert.equal(isValidSlug('with space'), false);
  assert.equal(isValidSlug('a'.repeat(76)), false, 'too long');
  assert.equal(isValidSlug('slash/slug'), false);
});

test('validateSeoForPublish requires metaDescription', () => {
  const errs = validateSeoForPublish({}, 'Title');
  assert.ok(errs.some((e) => e.field === 'seo.metaDescription' && e.constraint === 'required'));
});

test('validateSeoForPublish enforces 70-160 length', () => {
  const short = validateSeoForPublish({ metaDescription: 'too short' }, 'Title');
  assert.ok(short.some((e) => e.constraint === 'length'));
  const ok = validateSeoForPublish(
    { metaDescription: 'x'.repeat(120) },
    'Title',
  );
  assert.equal(ok.length, 0);
});

test('validateSeoForPublish flags long title', () => {
  const errs = validateSeoForPublish(
    { metaDescription: 'x'.repeat(120) },
    'T'.repeat(80),
  );
  assert.ok(errs.some((e) => e.field === 'title'));
});
