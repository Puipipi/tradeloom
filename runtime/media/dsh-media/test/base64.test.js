import test from 'node:test';
import assert from 'node:assert/strict';
import { base64DecodedLength } from '../src/base64.js';

test('RFC 4648 vectors have exact decoded lengths', () => {
  for (const [plain, encoded] of [
    ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy'],
  ]) {
    assert.equal(base64DecodedLength(encoded, plain.length), plain.length);
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), plain);
  }
});

test('all one-byte and two-byte payloads use canonical zero padding bits', () => {
  for (let a = 0; a < 256; a += 1) {
    const one = Buffer.from([a]).toString('base64');
    assert.equal(base64DecodedLength(one, 1), 1);
    for (let b = 0; b < 256; b += 1) {
      const two = Buffer.from([a, b]).toString('base64');
      assert.equal(base64DecodedLength(two, 2), 2);
    }
  }
});

test('invalid alphabets, internal padding and nonzero pad bits are rejected', () => {
  for (const value of [
    '', 'Zg', 'Zg=', 'Zg===', 'Zg==\n', ' Zg==', 'Zg==Zg==',
    '====', '=AAA', 'AA=A', 'AAA=', 'AAA!', 'AA-_',
    'Zh==', 'Zm9=', 'A\u0085AA', 'A\u007fAA',
  ]) {
    // AAA= is canonical for two zero bytes, and is handled as a positive control.
    if (value === 'AAA=') {
      assert.equal(base64DecodedLength(value, 2), 2);
      continue;
    }
    assert.throws(() => base64DecodedLength(value, 64), { code: 'response' }, JSON.stringify(value));
  }
});

test('encoded size and exact decoded size are checked before allocating bytes', () => {
  assert.throws(() => base64DecodedLength('AAAA', 2), { code: 'too_large' });
  assert.throws(() => base64DecodedLength('AAA=', 1), { code: 'too_large' });
  assert.throws(() => base64DecodedLength('AAAA'.repeat(1024), 1), { code: 'too_large' });
  assert.equal(base64DecodedLength('AA==', 1), 1);
  assert.equal(base64DecodedLength('AAA=', 2), 2);
  for (const limit of [0, -1, 1.5, Infinity, NaN, '1']) {
    assert.throws(() => base64DecodedLength('AA==', limit), { code: 'invalid_request' });
  }
});

test('large canonical input is linear and rejects a final bad alphabet character', () => {
  const encoded = 'AAAA'.repeat(1024 * 1024);
  assert.equal(base64DecodedLength(encoded, 3 * 1024 * 1024), 3 * 1024 * 1024);
  assert.throws(() => base64DecodedLength(encoded.slice(0, -1) + '!', 3 * 1024 * 1024),
    { code: 'response' });
});
