// Regression tests for the quote/comment-aware SQL statement splitter
// (fable-audit.md §6.4). The old line-based splitter corrupted statements that
// contained `;` or `--` inside string literals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitStatements } from '../../src/db/migrate.js';

test('splits top-level statements', () => {
  assert.deepEqual(
    splitStatements('CREATE TABLE a (id INT);\nINSERT INTO a VALUES (1);'),
    ['CREATE TABLE a (id INT)', 'INSERT INTO a VALUES (1)'],
  );
});

test('does not split on a semicolon inside a string literal', () => {
  assert.deepEqual(splitStatements("INSERT INTO t VALUES ('a;b');"), ["INSERT INTO t VALUES ('a;b')"]);
});

test('does not treat -- inside a string literal as a comment', () => {
  assert.deepEqual(splitStatements("INSERT INTO t VALUES ('a--b');"), ["INSERT INTO t VALUES ('a--b')"]);
});

test('strips line comments (incl. their semicolons) outside strings', () => {
  assert.deepEqual(
    splitStatements('SELECT 1; -- a comment ; with a semicolon\nSELECT 2;'),
    ['SELECT 1', 'SELECT 2'],
  );
});

test('handles backtick identifiers containing a semicolon', () => {
  assert.deepEqual(splitStatements('SELECT `we;ird` FROM t;'), ['SELECT `we;ird` FROM t']);
});

test('ignores block comments', () => {
  assert.deepEqual(splitStatements('SELECT 1 /* ; not a split */; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
});

test('keeps a trailing statement with no terminating semicolon', () => {
  assert.deepEqual(splitStatements('SELECT 1;\nSELECT 2'), ['SELECT 1', 'SELECT 2']);
});
