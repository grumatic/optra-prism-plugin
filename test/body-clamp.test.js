const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES, clampToWireLimit } = require('../lib/body-clamp');

function fits(text, maxDecodedBytes, maxEscapedBytes) {
  return Buffer.byteLength(text, 'utf8') <= maxDecodedBytes
    && Buffer.byteLength(JSON.stringify(text), 'utf8') <= maxEscapedBytes;
}

function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (isHigh && (text.charCodeAt(i + 1) < 0xdc00 || text.charCodeAt(i + 1) > 0xdfff)) return true;
    if (isLow && (i === 0 || text.charCodeAt(i - 1) < 0xd800 || text.charCodeAt(i - 1) > 0xdbff)) return true;
  }
  return false;
}

test('constants: MAX_PROMPT_BODY_BYTES is the server contract value; MAX_WIRE_BYTES is the frame-pair-safe wire budget', () => {
  assert.equal(MAX_PROMPT_BODY_BYTES, 2 * 1024 * 1024);
  // (6 MiB frame - 128 KiB envelope allowance) / 2, split evenly between a
  // maximal prompt and a maximal response in the same pair.
  assert.equal(MAX_WIRE_BYTES, (6 * 1024 * 1024 - 128 * 1024) / 2);
  assert.equal(MAX_WIRE_BYTES, 3080192);
  // Headroom under the per-route raw-bytes limit (2 * MAX_PROMPT_BODY_BYTES + 64 KiB).
  const routeLimit = 2 * MAX_PROMPT_BODY_BYTES + 64 * 1024;
  assert.equal(routeLimit - MAX_WIRE_BYTES, 1179648);
  assert.equal(MAX_WIRE_BYTES < routeLimit, true);
});

test('text under both bounds passes through unchanged', () => {
  const text = 'a short prompt';
  assert.equal(clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES), text);
});

test('ASCII text is clamped to the exact decoded-byte boundary when the decoded bound binds first', () => {
  const maxDecoded = 64;
  const maxEscaped = 10_000; // effectively unconstrained here
  const text = 'x'.repeat(200);
  const clamped = clampToWireLimit(text, maxDecoded, maxEscaped);
  assert.equal(Buffer.byteLength(clamped, 'utf8'), maxDecoded);
  assert.equal(fits(`${clamped}x`, maxDecoded, maxEscaped), false);
});

test('escape-heavy ASCII text is clamped to the exact escaped-byte boundary when the wire bound binds first', () => {
  const maxDecoded = 10_000; // effectively unconstrained here
  const maxEscaped = 64;
  const text = '"'.repeat(200); // each quote doubles to `\"` when escaped
  const clamped = clampToWireLimit(text, maxDecoded, maxEscaped);
  assert.equal(Buffer.byteLength(JSON.stringify(clamped), 'utf8'), maxEscaped);
  assert.equal(fits(`${clamped}"`, maxDecoded, maxEscaped), false);
});

test('multibyte content is clamped without splitting a UTF-8 code point', () => {
  // Each character is 1 UTF-16 code unit and 3 UTF-8 bytes, so a naive
  // byte-oriented slice (as opposed to a UTF-16-unit slice) could cut a
  // character's encoding in half.
  const maxDecoded = 61; // not a multiple of 3
  const text = '가'.repeat(200);
  const clamped = clampToWireLimit(text, maxDecoded, MAX_WIRE_BYTES);
  assert.equal(fits(clamped, maxDecoded, MAX_WIRE_BYTES), true);
  // Every character present in the clamp is a whole, correctly decoded
  // character — re-encoding it must round-trip without a replacement char.
  assert.equal(/^가*$/.test(clamped), true);
  assert.equal(Buffer.from(clamped, 'utf8').toString('utf8'), clamped);
});

test('a clamp cut that lands on a lone high surrogate drops the orphan unit', () => {
  // An astral emoji is a surrogate pair (2 UTF-16 units, 4 UTF-8 bytes).
  // Size the limit so the binary-search cut falls exactly between the high
  // and low surrogate: 1999 ASCII bytes = maxDecoded, landing the cut right
  // after the high surrogate.
  const maxDecoded = 1999;
  const text = `${'x'.repeat(1999)}\u{1F600}tail-beyond-limit`;
  const clamped = clampToWireLimit(text, maxDecoded, MAX_WIRE_BYTES);
  assert.equal(clamped, 'x'.repeat(1999));
  assert.equal(hasLoneSurrogate(clamped), false);
  assert.equal(fits(clamped, maxDecoded, MAX_WIRE_BYTES), true);
});

test('escape-heavy content keeps the JSON-escaped wire size within the limit', () => {
  // Quotes, backslashes, and control characters each expand to a longer
  // escape sequence (`"` -> `\"`, control chars -> `\u00XX`), so the escaped
  // wire size can exceed the raw UTF-8 size by several times over.
  const maxDecoded = 10_000;
  const maxEscaped = 200;
  const text = '"\\\n\t\r'.repeat(500);
  const clamped = clampToWireLimit(text, maxDecoded, maxEscaped);
  assert.equal(fits(clamped, maxDecoded, maxEscaped), true);
  assert.equal(clamped.length < text.length, true);
});

test('control-char-only bodies keep a meaningfully smaller decoded floor under the escaped bound than the 2 MiB decoded bound alone would allow', () => {
  // Each control character is 1 raw UTF-8 byte but escapes to `\u00XX` (6
  // bytes), so the wire bound (not the decoded bound) determines the floor
  // for this alphabet — this is the "control-char preservation ratio" the
  // dual-bound design accepts in exchange for giving plain content the full
  // 2 MiB decoded allowance.
  const text = '\x01'.repeat(MAX_PROMPT_BODY_BYTES); // all control chars: 1 decoded byte each
  const clamped = clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  const decodedBytes = Buffer.byteLength(clamped, 'utf8');
  const escapedBytes = Buffer.byteLength(JSON.stringify(clamped), 'utf8');
  assert.equal(escapedBytes <= MAX_WIRE_BYTES, true);
  assert.equal(decodedBytes < MAX_PROMPT_BODY_BYTES, true);
  // Every control char here escapes to exactly 6 bytes (\u00XX), so the
  // decoded floor is MAX_WIRE_BYTES / 6, rounded down by the binary search.
  const expectedFloor = Math.floor(MAX_WIRE_BYTES / 6);
  assert.equal(Math.abs(decodedBytes - expectedFloor) <= 1, true);
});

test('an under-limit input already ending in a lone high surrogate has the orphan dropped', () => {
  // JSON.parse permits an unpaired surrogate even though it is not valid
  // UTF-16 text on its own; this input never reaches the binary-search
  // clamp (it is far under both bounds), so the guard must run on the
  // early-return path too, not only after an actual clamp.
  const text = JSON.parse('"hello\\ud83d"');
  const clamped = clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  assert.equal(clamped, 'hello');
  assert.equal(hasLoneSurrogate(clamped), false);
});

test('a trailing lone low surrogate is stripped even though it is not the high-surrogate case the tail check alone would catch', () => {
  const text = JSON.parse('"hello\\udc00"');
  const clamped = clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  assert.equal(clamped, 'hello');
  assert.equal(hasLoneSurrogate(clamped), false);
});

test('a leading lone surrogate is stripped', () => {
  const text = JSON.parse('"\\ud800world"');
  const clamped = clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  assert.equal(clamped, 'world');
  assert.equal(hasLoneSurrogate(clamped), false);
});

test('a mid-string lone surrogate is stripped without disturbing well-formed text around it', () => {
  const text = JSON.parse('"before\\ud800after"');
  const clamped = clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  assert.equal(clamped, 'beforeafter');
  assert.equal(hasLoneSurrogate(clamped), false);
});

test('consecutive lone high surrogates are all stripped in one pass', () => {
  // Two adjacent lone high surrogates are not a valid pair with each other
  // (a pair needs a HIGH followed by a LOW), so both must be recognized and
  // removed — a naive "check only the trailing unit" approach would have
  // needed two passes (or missed the first one entirely) for this input.
  const text = JSON.parse('"a\\ud800\\ud800b"');
  const clamped = clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  assert.equal(clamped, 'ab');
  assert.equal(hasLoneSurrogate(clamped), false);
});

test('clamping is idempotent, including for consecutive lone high surrogates', () => {
  const text = '가'.repeat(5000);
  const once = clampToWireLimit(text, 1000, MAX_WIRE_BYTES);
  const twice = clampToWireLimit(once, 1000, MAX_WIRE_BYTES);
  assert.equal(once, twice);

  const surrogateText = JSON.parse('"a\\ud800\\ud800b"');
  const onceSurrogate = clampToWireLimit(surrogateText, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  const twiceSurrogate = clampToWireLimit(onceSurrogate, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  assert.equal(onceSurrogate, twiceSurrogate);
});

test('a valid surrogate pair (a real astral character) is left intact', () => {
  const text = 'before\u{1F600}after';
  const clamped = clampToWireLimit(text, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  assert.equal(clamped, text);
  assert.equal(hasLoneSurrogate(clamped), false);
});
