/**
 * Validation shared by prompt capture and Stop correlation.
 * Host prompt IDs are opaque; only their UTF-8 size and ASCII boundaries are
 * constrained so they remain compatible with the ingest contract.
 */

const MAX_HOST_PROMPT_ID_BYTES = 1024;
const ASCII_BOUNDARY_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

function validHostPromptId(value) {
  if (typeof value !== 'string') return false;
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength < 1 || byteLength > MAX_HOST_PROMPT_ID_BYTES) return false;
  return !ASCII_BOUNDARY_WHITESPACE.has(value.charCodeAt(0))
    && !ASCII_BOUNDARY_WHITESPACE.has(value.charCodeAt(value.length - 1));
}

module.exports = {
  MAX_HOST_PROMPT_ID_BYTES,
  validHostPromptId,
};
