const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  fingerprintApiKey,
  isSupportedApiKey,
} = require('../lib/api-key');

test('accepts Prism and legacy API key formats', () => {
  assert.equal(isSupportedApiKey('prism_1234567890abcdef'), true);
  assert.equal(isSupportedApiKey('gck_1234567890abcdef'), true);
});

test('rejects unsupported API key values', () => {
  for (const value of [null, undefined, 123, '', 'prism', 'gck', 'other_key']) {
    assert.equal(isSupportedApiKey(value), false, String(value));
  }
});

test('fingerprints the full API key without retaining credential material', () => {
  const apiKey = 'prism_1234567890abcdef';
  const fingerprint = fingerprintApiKey(apiKey);

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, fingerprintApiKey(apiKey));
  assert.notEqual(fingerprint, fingerprintApiKey('prism_different_key'));
  assert.equal(fingerprint.includes(apiKey), false);
});

test('returns null when a key cannot be fingerprinted', () => {
  for (const value of [null, undefined, 123, '']) {
    assert.equal(fingerprintApiKey(value), null, String(value));
  }
});
