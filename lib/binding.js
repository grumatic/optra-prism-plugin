/**
 * Local pairing check between the Prism API key and its ingest destination.
 *
 * `/prism:setup` verifies a key against the config endpoint and stores the
 * destination the server declares for that key. The pair is sealed into
 * `config.json` as `binding`, so any later edit of `apiKey` or `ingest_url`
 * alone — by `/prism:config`, by hand, or by switching environments — is
 * detectable locally without a network round trip.
 *
 * This is a pairing marker, not a security boundary. The key sits in the same
 * file, so the digest cannot resist forgery; it only proves the two stored
 * values were never changed independently of each other.
 *
 * The digest rule is duplicated in `otel-headers-helper.js`, which must stay
 * self-contained. Both implementations are pinned together by
 * `test/binding.test.js`; change one and the other must follow.
 */

const crypto = require('crypto');

const BINDING_DIGEST_LENGTH = 32;

function normalizeBindingUrl(value) {
  return value.toLowerCase().replace(/\/+$/, '');
}

function canonicalBindingInput(apiKey, ingestUrl) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  if (typeof ingestUrl !== 'string' || ingestUrl.length === 0) return null;
  return `${apiKey}\n${normalizeBindingUrl(ingestUrl)}`;
}

function bindingDigest(apiKey, ingestUrl) {
  const canonical = canonicalBindingInput(apiKey, ingestUrl);
  if (canonical === null) return null;
  return crypto
    .createHash('sha256')
    .update(canonical, 'utf8')
    .digest('hex')
    .slice(0, BINDING_DIGEST_LENGTH);
}

function hostOf(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Seal the pair that setup just verified. Returns null when either side is
 * unusable, so callers never persist a meaningless binding.
 */
function buildBinding({ apiKey, ingestUrl, now = new Date() } = {}) {
  const digest = bindingDigest(apiKey, ingestUrl);
  if (!digest) return null;
  return {
    digest,
    host: hostOf(ingestUrl),
    bound_at: now.toISOString(),
  };
}

/**
 * Classify the stored pair.
 *
 * `unbound` — no binding was ever sealed (installs that predate this contract).
 *             Fail open: behave exactly as before.
 * `ok`       — the stored pair still matches the sealed digest.
 * `mismatch` — one side changed after setup. Fail closed.
 */
function verifyBinding(config) {
  const source = config && typeof config === 'object' ? config : {};
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey : '';
  const ingestUrl = typeof source.ingest_url === 'string' ? source.ingest_url : '';
  const stored = source.binding && typeof source.binding === 'object' && !Array.isArray(source.binding)
    ? source.binding
    : null;
  const currentHost = hostOf(ingestUrl);

  if (!stored || typeof stored.digest !== 'string' || stored.digest.length === 0) {
    return { status: 'unbound', boundHost: null, currentHost };
  }

  const digest = bindingDigest(apiKey, ingestUrl);
  if (digest !== null && digest === stored.digest) {
    return { status: 'ok', boundHost: typeof stored.host === 'string' ? stored.host : null, currentHost };
  }

  return {
    status: 'mismatch',
    boundHost: typeof stored.host === 'string' ? stored.host : null,
    currentHost,
  };
}

module.exports = {
  BINDING_DIGEST_LENGTH,
  bindingDigest,
  buildBinding,
  canonicalBindingInput,
  normalizeBindingUrl,
  verifyBinding,
};
