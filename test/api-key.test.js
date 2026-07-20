const assert = require('node:assert/strict');
const { test } = require('node:test');

const { hasApiKey } = require('../lib/api-key');

test('accepts every non-empty string as an opaque API key', () => {
  for (const value of [
    'prism_1234567890abcdef',
    'gck_1234567890abcdef',
    'other_key',
    '  whitespace is opaque  ',
    'key\nwith\nnewlines',
  ]) {
    assert.equal(hasApiKey(value), true, JSON.stringify(value));
  }
});

test('rejects only empty and non-string API key values', () => {
  for (const value of ['', null, undefined, 0, 123, {}, []]) {
    assert.equal(hasApiKey(value), false, String(value));
  }
});
