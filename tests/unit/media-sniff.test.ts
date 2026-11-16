import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffDimensions } from '../../src/media/store.js';

function jpeg(w: number, h: number): Uint8Array {
  // SOI, APP0 (len 16), SOF0 with h/w, EOI
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12);
  const W = w - 1, H = h - 1;
  b.set([W & 255, (W >> 8) & 255, (W >> 16) & 255, H & 255, (H >> 8) & 255, (H >> 16) & 255], 24);
  return b;
}

test('jpeg dimensions', () => {
  assert.deepEqual(sniffDimensions(jpeg(2500, 1667), 'image/jpeg'), { w: 2500, h: 1667 });
});

test('webp declared as jpeg is measured as webp', () => {
  assert.deepEqual(sniffDimensions(webpVp8x(2500, 1667), 'image/jpeg'), { w: 2500, h: 1667 });
});

test('garbage yields nulls, not nonsense', () => {
  assert.deepEqual(sniffDimensions(new Uint8Array([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0, 0, 0]), 'image/jpeg'), { w: null, h: null });
});
