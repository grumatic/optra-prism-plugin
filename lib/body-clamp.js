/**
 * Byte-limit clamp shared by prompt and response capture. Two independent
 * bounds apply to the same field, and both must hold:
 *
 * - MAX_PROMPT_BODY_BYTES (2 MiB): the ingest service's contract limit on
 *   the DECODED UTF-8 size of the field. This is what "prompt_body_exceeds_
 *   limit" / "response_body_exceeds_limit" actually measure server-side.
 * - MAX_WIRE_BYTES (~2.9375 MiB): the JSON-ESCAPED size on the wire. The
 *   ingest service projects a prompt/response pair into a combined request
 *   frame of at most 6 MiB; reserving 128 KiB of that for JSON envelope
 *   overhead on both requests and splitting the remainder evenly between
 *   the two fields gives (6 MiB - 128 KiB) / 2 = 3,080,192 bytes. That
 *   128 KiB reserve must also absorb the server's fixed 12-byte frame header
 *   and up to 64 KiB of frame metadata, leaving roughly 64 KiB for each
 *   request's own non-text envelope fields (ids, timestamps, and the like).
 *   This clears the per-route raw-bytes limit (2 * MAX_PROMPT_BODY_BYTES +
 *   64 KiB = 4,259,840 bytes, ~4.06 MiB) with about 1.125 MiB of headroom,
 *   so that route's rejection path stays unreachable from this client.
 *
 * Clamping on the escaped bound alone (as an earlier version of this file
 * did) shortchanges escape-heavy content — pasted logs and diffs are full of
 * newlines and quotes — to a fraction of the 2 MiB the server actually
 * allows. Enforcing both bounds together keeps ordinary content at the full
 * 2 MiB decoded allowance while still capping the wire size independently.
 */

const MAX_PROMPT_BODY_BYTES = 2 * 1024 * 1024;
const SERVER_FRAME_BYTES = 6 * 1024 * 1024;
const FRAME_ENVELOPE_ALLOWANCE_BYTES = 128 * 1024;
const MAX_WIRE_BYTES = (SERVER_FRAME_BYTES - FRAME_ENVELOPE_ALLOWANCE_BYTES) / 2;

// Matches a high surrogate not followed by its low partner, or a low
// surrogate not preceded by its high partner, anywhere in the string — not
// just at the end. JSON.parse of hook stdin can produce a lone surrogate at
// any position (the host is not obligated to send well-formed UTF-16), and
// JSON.stringify re-emits any of them as an unpaired \uXXXX escape, which a
// strict UTF-8 JSON parser (serde_json) rejects outright regardless of where
// in the string it sits.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function stripLoneSurrogates(text) {
  return text.replace(LONE_SURROGATE, '');
}

function fitsBothBounds(candidate, maxDecodedBytes, maxEscapedBytes) {
  return Buffer.byteLength(candidate, 'utf8') <= maxDecodedBytes
    && Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxEscapedBytes;
}

// Clamps to the largest prefix of the (surrogate-scrubbed) input that fits
// both maxDecodedBytes (raw UTF-8) and maxEscapedBytes (JSON-escaped). The
// binary search below only ever accepts a mid-point whose own measured size
// fits both bounds, so it is safe even though neither measure is strictly
// monotonic in prefix length (a cut through the middle of a surrogate pair
// escapes to a lone \uXXXX, 6 bytes, longer than the completed pair's 4) —
// the worst case is landing one character short of the true optimum, never
// over either limit.
function clampToWireLimit(text, maxDecodedBytes, maxEscapedBytes) {
  const scrubbed = stripLoneSurrogates(text);
  let sliced = scrubbed;
  if (!fitsBothBounds(scrubbed, maxDecodedBytes, maxEscapedBytes)) {
    let lo = 0;
    let hi = scrubbed.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fitsBothBounds(scrubbed.slice(0, mid), maxDecodedBytes, maxEscapedBytes)) lo = mid;
      else hi = mid - 1;
    }
    sliced = scrubbed.slice(0, lo);
  }
  // The scrub above removes every pre-existing lone surrogate, but slicing
  // the (now clean) text at an arbitrary UTF-16 index can still cut a valid
  // pair in half, leaving a new lone high surrogate at the very end. Drop it.
  const lastUnit = sliced.charCodeAt(sliced.length - 1);
  const isLoneHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return isLoneHighSurrogate ? sliced.slice(0, -1) : sliced;
}

module.exports = { MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES, clampToWireLimit };
