import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpAt,
  matchTotp,
  verifyTotpForUser,
  otpauthUrl,
  createPendingLogin,
  usePendingLogin,
  clearPendingLogin,
} from '../../src/auth/totp.js';
import { qrMatrix, qrSvg } from '../../src/admin/qr.js';

// RFC 6238 appendix B (SHA-1), truncated to 6 digits.
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

test('base32 round-trips', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(new TextDecoder().decode(base32Decode(RFC_SECRET)), '12345678901234567890');
  assert.equal(new TextDecoder().decode(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')), '12345678901234567890');
  assert.match(generateTotpSecret(), /^[A-Z2-7]{32}$/);
});

test('totpAt matches the RFC 6238 vectors', async () => {
  assert.equal(await totpAt(RFC_SECRET, 59_000), '287082');
  assert.equal(await totpAt(RFC_SECRET, 1_111_111_109_000), '081804');
  assert.equal(await totpAt(RFC_SECRET, 1_234_567_890_000), '005924');
});

test('matchTotp allows one step of drift and nothing else', async () => {
  assert.notEqual(await matchTotp(RFC_SECRET, '287082', 59_000), null);
  assert.notEqual(await matchTotp(RFC_SECRET, '287 082', 59_000 + 30_000), null);
  assert.equal(await matchTotp(RFC_SECRET, '287082', 59_000 + 90_000), null);
  assert.equal(await matchTotp(RFC_SECRET, '28708', 59_000), null);
  assert.equal(await matchTotp(RFC_SECRET, 'abcdef', 59_000), null);
  assert.equal(await matchTotp('', '287082', 59_000), null);
});

test('a sign-in code is accepted only once', async () => {
  const secret = generateTotpSecret();
  const code = await totpAt(secret);
  assert.equal(await verifyTotpForUser(9001, secret, code), true);
  assert.equal(await verifyTotpForUser(9001, secret, code), false);
  assert.equal(await verifyTotpForUser(9002, null, code), false);
  assert.equal(await verifyTotpForUser(9002, secret, '000000') && (await totpAt(secret)) !== '000000', false);
});

test('pending sign-in tickets expire after too many tries', () => {
  const ticket = createPendingLogin(7, 'a@example.com');
  assert.deepEqual(usePendingLogin(ticket), { userId: 7, email: 'a@example.com' });
  for (let i = 0; i < 4; i++) assert.ok(usePendingLogin(ticket));
  assert.equal(usePendingLogin(ticket), null);
  assert.equal(usePendingLogin('nope'), null);
  const other = createPendingLogin(8, 'b@example.com');
  clearPendingLogin(other);
  assert.equal(usePendingLogin(other), null);
});

test('otpauth link and QR code', () => {
  const url = otpauthUrl(RFC_SECRET, 'user@example.com', 'My: Site');
  assert.equal(url, `otpauth://totp/My%20%20Site%3Auser%40example.com?secret=${RFC_SECRET}&issuer=My%20%20Site`);
  const m = qrMatrix(url)!;
  assert.ok(m.length >= 21 && m.every((row) => row.length === m.length));
  // Finder pattern corners are always dark.
  assert.ok(m[0]![0] && m[0]![m.length - 1] && m[m.length - 1]![0]);
  assert.match(qrSvg(url), /^<svg /);
  assert.equal(qrSvg('x'.repeat(400)), '');
});
