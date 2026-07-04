// Regression tests for the privilege-escalation guards (fable-audit.md §2.1):
// a role/user manager must not be able to grant capabilities — or assign a role
// — more powerful than the capabilities it already holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantsWithinActor, isCapabilitiesShape } from '../../src/permissions/check.js';

const admin = { global: ['*'], types: {} };
// A limited manager: no delete, no manageUsers/manageRoles.
const editor = { global: ['viewSubmissions'], types: { '*': ['read', 'create', 'update', 'publish'] } };

test('admin (global *) can grant anything', () => {
  assert.equal(grantsWithinActor(admin, { global: ['*'], types: {} }), true);
  assert.equal(grantsWithinActor(admin, { global: ['manageUsers'], types: { post: ['delete'] } }), true);
});

test('non-admin cannot grant the wildcard', () => {
  assert.equal(grantsWithinActor(editor, { global: ['*'], types: {} }), false);
});

test('non-admin cannot grant a global capability it lacks', () => {
  assert.equal(grantsWithinActor(editor, { global: ['manageUsers'], types: {} }), false);
});

test('non-admin cannot grant a per-type capability it lacks', () => {
  // editor has read/create/update/publish on '*' but NOT delete
  assert.equal(grantsWithinActor(editor, { global: [], types: { post: ['delete'] } }), false);
});

test('non-admin can grant capabilities it already holds', () => {
  assert.equal(
    grantsWithinActor(editor, { global: ['viewSubmissions'], types: { post: ['read', 'create'] } }),
    true,
  );
});

test('isCapabilitiesShape accepts valid shapes and rejects malformed input', () => {
  assert.equal(isCapabilitiesShape({ global: [], types: {} }), true);
  assert.equal(isCapabilitiesShape({ global: ['manageUsers'] }), true);
  assert.equal(isCapabilitiesShape({ global: 'nope' }), false);
  assert.equal(isCapabilitiesShape(null), false);
  assert.equal(isCapabilitiesShape({ global: [], types: { post: 'x' } }), false);
});
