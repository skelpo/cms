import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

test('hash + verify round-trip', async () => {
  const h = await hashPassword('Test1234!');
  assert.match(h, /^\$2[aby]\$/);
  assert.equal(await verifyPassword('Test1234!', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});

test('rejects too-short passwords', async () => {
  await assert.rejects(() => hashPassword('short'), /at least 8/);
});

test('rejects over-long passwords', async () => {
  await assert.rejects(() => hashPassword('x'.repeat(201)), /200 characters/);
});

test('verify is safe on empty input', async () => {
  assert.equal(await verifyPassword('', ''), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});
