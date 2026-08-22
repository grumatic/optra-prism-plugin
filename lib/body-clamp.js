// Two bounds both apply: MAX_PROMPT_BODY_BYTES (2 MiB decoded, the server's contract limit) and MAX_WIRE_BYTES (~2.9375 MiB JSON-escaped); the 128 KiB reserve covers the server's frame header, frame metadata, and each request's own envelope fields.
const MAX_PROMPT_BODY_BYTES = 2 * 1024 * 1024;
const SERVER_FRAME_BYTES = 6 * 1024 * 1024;
const FRAME_ENVELOPE_ALLOWANCE_BYTES = 128 * 1024;
const MAX_WIRE_BYTES = (SERVER_FRAME_BYTES - FRAME_ENVELOPE_ALLOWANCE_BYTES) / 2;

// Scrubbed because JSON.stringify re-emits a lone surrogate as an unpaired \uXXXX escape, which the server's strict UTF-8 JSON parser rejects outright.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function stripLoneSurrogates(text) {
  return text.replace(LONE_SURROGATE, '');
}

function fitsBothBounds(candidate, maxDecodedBytes, maxEscapedBytes) {
  return Buffer.byteLength(candidate, 'utf8') <= maxDecodedBytes
    && Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxEscapedBytes;
}

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
  const lastUnit = sliced.charCodeAt(sliced.length - 1);
  const isLoneHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return isLoneHighSurrogate ? sliced.slice(0, -1) : sliced;
}

module.exports = { MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES, clampToWireLimit };
