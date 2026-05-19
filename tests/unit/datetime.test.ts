import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateToIso, normalizeDates } from '../../src/db/datetime.js';

const myDt = { year: 2026, month: 5, day: 19, hour: 18, minute: 30, second: 0, microsecond: 0, raw: '2026-05-19 18:30:00' };

test('dateToIso converts MyDateTime', () => {
  assert.equal(dateToIso(myDt), '2026-05-19T18:30:00Z');
});

test('dateToIso converts MySQL string', () => {
  assert.equal(dateToIso('2026-05-19 18:30:00'), '2026-05-19T18:30:00Z');
});

test('dateToIso passes through null/ISO', () => {
  assert.equal(dateToIso(null), null);
  assert.equal(dateToIso(undefined), null);
  assert.equal(dateToIso('not-a-date'), 'not-a-date');
});

test('normalizeDates walks nested objects + arrays', () => {
  const input = {
    id: 1,
    createdAt: myDt,
    nested: { updatedAt: myDt, name: 'x' },
    list: [{ at: myDt }, { at: null }],
  };
  const out = normalizeDates(input) as typeof input & {
    createdAt: string;
    nested: { updatedAt: string };
    list: { at: string | null }[];
  };
  assert.equal(out.createdAt, '2026-05-19T18:30:00Z');
  assert.equal(out.nested.updatedAt, '2026-05-19T18:30:00Z');
  assert.equal(out.nested.name, 'x');
  assert.equal(out.list[0]!.at, '2026-05-19T18:30:00Z');
  assert.equal(out.list[1]!.at, null);
  assert.equal(out.id, 1);
});

test('normalizeDates leaves plain values intact', () => {
  assert.equal(normalizeDates('plain'), 'plain');
  assert.equal(normalizeDates(42), 42);
  assert.equal(normalizeDates(null), null);
});
