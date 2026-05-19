import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can } from '../../src/permissions/check.js';

const adminCaps = {
  global: ['*'],
  types: { '*': ['read', 'create', 'update', 'delete', 'publish', 'readDrafts'] },
};
const editorCaps = {
  global: [],
  types: { '*': ['read', 'create', 'update', 'delete', 'publish', 'readDrafts'] },
};
const authorCaps = {
  global: [],
  types: { page: ['read'], post: ['read', 'create', 'updateOwn', 'deleteOwn', 'publish'] },
};

test('admin wildcard grants any type action', () => {
  const ctx = { userId: 1, caps: adminCaps };
  assert.equal(can(ctx, 'publish', 'post'), true);
  assert.equal(can(ctx, 'delete', 'anything'), true);
});

test('admin global * grants global capabilities', () => {
  const ctx = { userId: 1, caps: adminCaps };
  assert.equal(can(ctx, 'manageUsers'), true);
  assert.equal(can(ctx, 'manageSettings'), true);
});

test('editor lacks global manage caps', () => {
  const ctx = { userId: 2, caps: editorCaps };
  assert.equal(can(ctx, 'manageUsers'), false);
  assert.equal(can(ctx, 'publish', 'post'), true);
});

test('per-type read via wildcard type', () => {
  const ctx = { userId: 2, caps: editorCaps };
  assert.equal(can(ctx, 'read', 'doc'), true);
});

test('author updateOwn requires ownership', () => {
  const ctx = { userId: 7, caps: authorCaps };
  assert.equal(can(ctx, 'updateOwn', 'post', 7), true, 'owns it');
  assert.equal(can(ctx, 'updateOwn', 'post', 99), false, 'not owner');
  assert.equal(can(ctx, 'updateOwn', 'post', null), false, 'no owner');
});

test('author cannot act on type without grant', () => {
  const ctx = { userId: 7, caps: authorCaps };
  assert.equal(can(ctx, 'create', 'page'), false);
  assert.equal(can(ctx, 'read', 'page'), true);
});

test('update falls back to updateOwn ownership when only *Own granted', () => {
  const ctx = { userId: 7, caps: authorCaps };
  assert.equal(can(ctx, 'update', 'post', 7), true);
  assert.equal(can(ctx, 'update', 'post', 8), false);
});

test('global action without typeSlug returns false for non-global', () => {
  const ctx = { userId: 2, caps: editorCaps };
  assert.equal(can(ctx, 'read'), false, 'read needs a type');
});

test('unknown type with no wildcard denies', () => {
  const ctx = { userId: 7, caps: { global: [], types: { post: ['read'] } } };
  assert.equal(can(ctx, 'read', 'page'), false);
});
