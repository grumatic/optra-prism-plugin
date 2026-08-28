// Both the decoded body limit and the escaped wire-frame budget must hold.

const MAX_PROMPT_BODY_BYTES = 2 * 1024 * 1024;
const SERVER_FRAME_BYTES = 6 * 1024 * 1024;
const FRAME_ENVELOPE_ALLOWANCE_BYTES = 128 * 1024;
const MAX_WIRE_BYTES = (SERVER_FRAME_BYTES - FRAME_ENVELOPE_ALLOWANCE_BYTES) / 2;

// Strict JSON consumers reject lone UTF-16 surrogates emitted as \uXXXX.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function stripLoneSurrogates(text) {
  return text.replace(LONE_SURROGATE, '');
}

function fitsBothBounds(candidate, maxDecodedBytes, maxEscapedBytes) {
  return Buffer.byteLength(candidate, 'utf8') <= maxDecodedBytes
    && Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxEscapedBytes;
}

// Accept only measured prefixes that fit both decoded and escaped bounds.
function clampToWireLimitWithEvidence(text, maxDecodedBytes, maxEscapedBytes) {
  const scrubbed = stripLoneSurrogates(text);
  let sliced = scrubbed;
  const sizeClamped = !fitsBothBounds(scrubbed, maxDecodedBytes, maxEscapedBytes);
  if (sizeClamped) {
    let lo = 0;
    let hi = scrubbed.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fitsBothBounds(scrubbed.slice(0, mid), maxDecodedBytes, maxEscapedBytes)) lo = mid;
      else hi = mid - 1;
    }
    sliced = scrubbed.slice(0, lo);
  }
  // Slicing can create a trailing lone high surrogate.
  const lastUnit = sliced.charCodeAt(sliced.length - 1);
  const isLoneHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return {
    text: isLoneHighSurrogate ? sliced.slice(0, -1) : sliced,
    // Surrogate scrubbing is reported separately through `truncated`.
    sizeClamped,
  };
}

function clampToWireLimit(text, maxDecodedBytes, maxEscapedBytes) {
  return clampToWireLimitWithEvidence(text, maxDecodedBytes, maxEscapedBytes).text;
}

module.exports = {
  MAX_PROMPT_BODY_BYTES,
  MAX_WIRE_BYTES,
  clampToWireLimit,
  clampToWireLimitWithEvidence,
};
