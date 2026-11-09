'use strict';

/**
 * `git-evidence/v1` capability gate: whether the configured ingest service
 * currently accepts committed-evidence reports. Cached per binding
 * (API key + ingest URL pair), refreshed at most once every five minutes.
 *
 * Two gates read the cache. Delivery (`capabilityAllowsEvidence`) closes
 * once an hour passes with no confirmed success. Capture
 * (`capabilityAllowsCapture`) keeps evidence flowing into the local outbox
 * while delivery waits, and closes only on a refusal a refresh confirmed or
 * once the pending retention period passes with no confirmed success.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { defaultPluginDataDir } = require('./claude-paths');
const path = require('path');
const { bindingDigest } = require('./binding');
const { addPluginVersionHeader } = require('./plugin-version');
const {
  GIT_EVIDENCE_ENDPOINT_PATH,
  GIT_EVIDENCE_SCHEMA_VERSION,
  GIT_EVIDENCE_SCHEMA_VERSION_V2,
  GIT_EVIDENCE_SCHEMA_VERSIONS,
} = require('./git-evidence-contract');
const { createDebug } = require('./debug');
const { EVIDENCE_PENDING_RETENTION_MS } = require('./git-evidence-outbox');

const debug = createDebug('git-evidence-capability');

const CAPABILITY_REFRESH_INTERVAL_MS = 300000;
const CAPABILITY_MAX_STALE_MS = 3600000;
const CAPABILITY_REQUEST_TIMEOUT_MS = 1000;
const CAPABILITY_MAX_RESPONSE_BYTES = 16384;
const CAPABILITY_CACHE_SCHEMA = 'git-evidence-capability-cache/v1';
const CAPABILITY_STATES = Object.freeze([
  'supported', 'unsupported', 'auth_error', 'withdrawn', 'protocol_error',
]);
// `source: 'refresh'` marks an `auth_error` the config endpoint itself
// answered, the one refusal state a delivery response can also set. It is
// written on that state only, so a cache an older plugin rejects for this
// key is one whose state already closes that plugin's gates. A delivery
// response writes no source: an older plugin sharing the data directory
// must keep reading its cache, or it would replace it on a failed refresh
// with one that holds no contract.
const CAPABILITY_SNAPSHOT_KEYS = new Set([
  'schema_version', 'binding_digest', 'checked_at', 'last_success_at', 'state', 'endpoint', 'versions', 'source',
]);
const CAPABILITY_REFRESH_SOURCE = 'refresh';
const CAPABILITY_SOURCES = new Set([CAPABILITY_REFRESH_SOURCE]);
const NEVER_SUCCEEDED_AT = new Date(0).toISOString();

function runtimeEnv() {
  return require('./env');
}

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA
    || defaultPluginDataDir();
}

function currentBindingDigest() {
  const { API_KEY, INGEST_URL } = runtimeEnv();
  return bindingDigest(API_KEY, INGEST_URL);
}

function capabilityCacheFile(digest) {
  return path.join(dataDir(), 'runtime', `git-evidence-capability-${digest}.json`);
}

function isValidSnapshot(value, digest) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => CAPABILITY_SNAPSHOT_KEYS.has(key))
    && value.schema_version === CAPABILITY_CACHE_SCHEMA
    && typeof value.binding_digest === 'string'
    && value.binding_digest === digest
    && typeof value.checked_at === 'string'
    && Number.isFinite(Date.parse(value.checked_at))
    && typeof value.last_success_at === 'string'
    && Number.isFinite(Date.parse(value.last_success_at))
    && CAPABILITY_STATES.includes(value.state)
    && (value.endpoint === undefined || typeof value.endpoint === 'string')
    && (value.versions === undefined
      || (Array.isArray(value.versions) && value.versions.every((version) => typeof version === 'string')))
    && (value.source === undefined || CAPABILITY_SOURCES.has(value.source)),
  );
}

/** Reads and validates the cache for the current binding. Never performs I/O to the network. */
function readCapabilityCache({ now } = {}) {
  void now;
  const digest = currentBindingDigest();
  if (!digest) return null;

  const file = capabilityCacheFile(digest);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > CAPABILITY_MAX_RESPONSE_BYTES) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return isValidSnapshot(parsed, digest) ? parsed : null;
}

const ORPHAN_TEMP_AGE_MS = 300000;
// Matches the generic dotfile-temp pattern reaped elsewhere in this runtime
// directory (response-outbox.js, git-evidence-outbox.js), so a temp file
// orphaned by a crash between writeFileSync and renameSync/unlinkSync is
// eventually cleaned up rather than accumulating forever.
const CAPABILITY_TEMP_PATTERN = /^\.[a-f0-9-]+\.tmp$/;

function reapOrphanCapabilityTemps(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - ORPHAN_TEMP_AGE_MS;
  for (const name of names) {
    if (!CAPABILITY_TEMP_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

function writeCapabilityCache(snapshot) {
  const dir = path.join(dataDir(), 'runtime');
  const file = capabilityCacheFile(snapshot.binding_digest);
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    reapOrphanCapabilityTemps(dir);
    fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch (error) {
    debug(`ERROR capability cache write: ${(error && error.code) || 'unknown'}`);
    return false;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

/** Pure gate. No I/O. */
function capabilityAllowsEvidence(snapshot, now = Date.now()) {
  if (!snapshot) return false;
  const digest = currentBindingDigest();
  if (!digest) return false;
  return snapshot.state === 'supported'
    && snapshot.endpoint === GIT_EVIDENCE_ENDPOINT_PATH
    && Array.isArray(snapshot.versions)
    && snapshot.versions.includes(GIT_EVIDENCE_SCHEMA_VERSION)
    && snapshot.binding_digest === digest
    && Number.isFinite(Date.parse(snapshot.last_success_at))
    && now - Date.parse(snapshot.last_success_at) <= CAPABILITY_MAX_STALE_MS;
}

/**
 * Why capture is closed for `snapshot`, or null when it is open. Pure.
 * Capture outlives delivery's one-hour freshness: evidence is collected into
 * the outbox while delivery waits for a refresh, up to the outbox's own
 * retention period after the last confirmed success.
 */
function captureClosedReason(snapshot, now = Date.now()) {
  if (!snapshot) return 'missing';
  const digest = currentBindingDigest();
  if (!digest || snapshot.binding_digest !== digest) return 'missing';
  // Only a refusal the config endpoint itself answered stops capture.
  // `unsupported` (a refresh found no git-evidence contract) carries no
  // endpoint and closes below. `withdrawn` is only ever set by a delivery
  // response, and an `auth_error` not marked as a refresh's may be one too
  // (or come from an older plugin that cannot mark it): both may be a
  // deploy, a proxy or an auth outage, so they only pause delivery.
  if (snapshot.state === 'auth_error' && snapshot.source === CAPABILITY_REFRESH_SOURCE) return 'auth_error';
  if (snapshot.endpoint !== GIT_EVIDENCE_ENDPOINT_PATH
    || !Array.isArray(snapshot.versions)
    || !snapshot.versions.includes(GIT_EVIDENCE_SCHEMA_VERSION)) {
    return snapshot.state === 'supported' ? 'protocol_error' : snapshot.state;
  }
  const lastSuccess = Date.parse(snapshot.last_success_at);
  if (!Number.isFinite(lastSuccess) || now - lastSuccess > EVIDENCE_PENDING_RETENTION_MS) return 'expired';
  return null;
}

/** Pure gate for collecting evidence into the outbox. No I/O. */
function capabilityAllowsCapture(snapshot, now = Date.now()) {
  return captureClosedReason(snapshot, now) === null;
}

/**
 * Pure. The body version a new capture is built with: v2 once the service
 * lists it, else v1. A cache written before v2 existed lists only v1.
 */
function negotiatedEvidenceVersion(snapshot) {
  return snapshot && Array.isArray(snapshot.versions) && snapshot.versions.includes(GIT_EVIDENCE_SCHEMA_VERSION_V2)
    ? GIT_EVIDENCE_SCHEMA_VERSION_V2
    : GIT_EVIDENCE_SCHEMA_VERSION;
}

function priorField(cached, digest, key) {
  return cached && cached.binding_digest === digest && cached[key] !== undefined ? cached[key] : undefined;
}

function priorLastSuccessAt(cached, digest) {
  return priorField(cached, digest, 'last_success_at') || NEVER_SUCCEEDED_AT;
}

/**
 * Fetch outcome -> the next persisted snapshot, preserving what each transition requires.
 * `versions` (supported only) is the advertised list, already narrowed to
 * the versions this plugin can build.
 */
function nextSnapshotFor(outcomeKind, cached, digest, nowIso, versions = [GIT_EVIDENCE_SCHEMA_VERSION]) {
  if (outcomeKind === 'supported') {
    return {
      schema_version: CAPABILITY_CACHE_SCHEMA,
      binding_digest: digest,
      checked_at: nowIso,
      last_success_at: nowIso,
      state: 'supported',
      endpoint: GIT_EVIDENCE_ENDPOINT_PATH,
      versions,
    };
  }
  if (outcomeKind === 'unsupported') {
    return {
      schema_version: CAPABILITY_CACHE_SCHEMA,
      binding_digest: digest,
      checked_at: nowIso,
      last_success_at: nowIso,
      state: 'unsupported',
    };
  }
  if (outcomeKind === 'auth_error' || outcomeKind === 'protocol_error') {
    return {
      schema_version: CAPABILITY_CACHE_SCHEMA,
      binding_digest: digest,
      checked_at: nowIso,
      last_success_at: priorLastSuccessAt(cached, digest),
      state: outcomeKind,
      ...(priorField(cached, digest, 'endpoint') !== undefined ? { endpoint: priorField(cached, digest, 'endpoint') } : {}),
      ...(priorField(cached, digest, 'versions') !== undefined ? { versions: priorField(cached, digest, 'versions') } : {}),
      // The config endpoint itself refused the key: capture stops too.
      ...(outcomeKind === 'auth_error' ? { source: CAPABILITY_REFRESH_SOURCE } : {}),
    };
  }
  // transient: network error, timeout, 408, 425, 429, 5xx — the previous
  // state is kept verbatim, including where it came from: a refusal set by a
  // delivery response must not turn into a confirmed one because a refresh
  // could not reach the service. last_success_at never advances, so the
  // gates' own staleness checks are what eventually close them with no
  // further network call.
  const priorState = priorField(cached, digest, 'state') || 'protocol_error';
  return {
    schema_version: CAPABILITY_CACHE_SCHEMA,
    binding_digest: digest,
    checked_at: nowIso,
    last_success_at: priorLastSuccessAt(cached, digest),
    state: priorState,
    ...(priorField(cached, digest, 'endpoint') !== undefined ? { endpoint: priorField(cached, digest, 'endpoint') } : {}),
    ...(priorField(cached, digest, 'versions') !== undefined ? { versions: priorField(cached, digest, 'versions') } : {}),
    ...(priorField(cached, digest, 'source') !== undefined ? { source: priorField(cached, digest, 'source') } : {}),
  };
}

function fetchCapabilityConfig() {
  return new Promise((resolve) => {
    const { API_KEY, INGEST_URL } = runtimeEnv();
    if (!API_KEY || !INGEST_URL) {
      resolve({ kind: 'protocol_error' });
      return;
    }

    let url;
    try {
      url = new URL(`${INGEST_URL.replace(/\/+$/, '')}/v1/plugin/config`);
    } catch {
      resolve({ kind: 'protocol_error' });
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let deadlineTimer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(value);
    };

    let req;
    try {
      req = transport.request(url, {
        method: 'GET',
        headers: addPluginVersionHeader({ 'x-api-key': API_KEY }),
        timeout: CAPABILITY_REQUEST_TIMEOUT_MS,
      }, (res) => {
        const status = res.statusCode;
        let bytes = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > CAPABILITY_MAX_RESPONSE_BYTES) {
            // Settle and destroy immediately: a response that never reaches
            // `end` (a trickling or stalled body) must not hold the drain
            // hostage until the byte budget happens to be crossed.
            settle({ kind: 'protocol_error' });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (status === 401 || status === 403) { settle({ kind: 'auth_error' }); return; }
          if (status === 200) {
            let parsed;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              settle({ kind: 'protocol_error' });
              return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              settle({ kind: 'protocol_error' });
              return;
            }
            const contract = parsed.contracts && typeof parsed.contracts === 'object'
              ? parsed.contracts.git_evidence
              : null;
            const endpointOk = contract && contract.endpoint === GIT_EVIDENCE_ENDPOINT_PATH;
            const versionsOk = contract
              && Array.isArray(contract.versions)
              && contract.versions.includes(GIT_EVIDENCE_SCHEMA_VERSION);
            if (!(endpointOk && versionsOk)) {
              settle({ kind: 'unsupported' });
              return;
            }
            // Only versions this plugin can build are kept, oldest first, so
            // the cache never carries an arbitrary server-supplied list.
            settle({
              kind: 'supported',
              versions: GIT_EVIDENCE_SCHEMA_VERSIONS.filter((version) => contract.versions.includes(version)),
            });
            return;
          }
          if (status === 408 || status === 425 || status === 429 || status >= 500) {
            settle({ kind: 'transient' });
            return;
          }
          settle({ kind: 'protocol_error' });
        });
      });
      req.on('error', () => settle({ kind: 'transient' }));
      req.on('timeout', () => {
        req.destroy();
        settle({ kind: 'transient' });
      });
      // A hard wall-clock deadline, independent of the idle `timeout` option
      // above: a response that keeps trickling bytes resets Node's idle
      // timer forever, so only an unconditional deadline actually bounds the
      // total request duration.
      deadlineTimer = setTimeout(() => {
        req.destroy();
        settle({ kind: 'transient' });
      }, CAPABILITY_REQUEST_TIMEOUT_MS);
      req.end();
    } catch {
      settle({ kind: 'protocol_error' });
    }
  });
}

/**
 * Refresh when due, then return the snapshot. Performs at most one HTTP GET.
 * Never throws.
 */
async function refreshCapability({ now = Date.now(), force = false } = {}) {
  const digest = currentBindingDigest();
  if (!digest) return null;

  const cached = readCapabilityCache({ now });
  const checkedAgeMs = cached && Number.isFinite(Date.parse(cached.checked_at))
    ? now - Date.parse(cached.checked_at)
    : Infinity;
  const isDue = force || !cached || checkedAgeMs >= CAPABILITY_REFRESH_INTERVAL_MS;
  if (!isDue) return cached;

  let outcome;
  try {
    outcome = await fetchCapabilityConfig();
  } catch {
    outcome = { kind: 'transient' };
  }
  const nowIso = new Date(now).toISOString();
  const next = nextSnapshotFor(outcome.kind, cached, digest, nowIso, outcome.versions);
  if (!writeCapabilityCache(next)) return { ...next, state: 'protocol_error' };
  return next;
}

function publishDeliveryTransition(state) {
  const digest = currentBindingDigest();
  if (!digest) return false;
  const cached = readCapabilityCache();
  const nowIso = new Date().toISOString();
  const next = {
    schema_version: CAPABILITY_CACHE_SCHEMA,
    binding_digest: digest,
    checked_at: nowIso,
    last_success_at: priorLastSuccessAt(cached, digest),
    state,
    ...(priorField(cached, digest, 'endpoint') !== undefined ? { endpoint: priorField(cached, digest, 'endpoint') } : {}),
    ...(priorField(cached, digest, 'versions') !== undefined ? { versions: priorField(cached, digest, 'versions') } : {}),
    // A delivery response that only repeats a refusal a refresh confirmed
    // (a drain begun before that refresh) keeps the refresh's mark, so it
    // cannot reopen capture under a key the service has refused.
    ...(priorField(cached, digest, 'state') === state && priorField(cached, digest, 'source') !== undefined
      ? { source: priorField(cached, digest, 'source') }
      : {}),
  };
  return writeCapabilityCache(next);
}

/** Atomic transitions driven by delivery outcomes. */
function markCapabilityWithdrawn() {
  return publishDeliveryTransition('withdrawn');
}
function markCapabilityProtocolError() {
  return publishDeliveryTransition('protocol_error');
}
function markCapabilityAuthError() {
  return publishDeliveryTransition('auth_error');
}
/**
 * The service refused a version it advertised (an ingest rolled back past
 * it): stop building that version until the next refresh lists it again.
 * No network call is made, and only the version list changes: the snapshot
 * read here is written back otherwise as is, so the gate state is not
 * replaced from a second read, and checked_at is not advanced by a check
 * that never ran. Without a valid cached snapshot listing that version there
 * is nothing to withdraw, so nothing is written — a backlog of refused
 * entries rewrites the cache once.
 */
function markCapabilityVersionRejected(version) {
  const cached = readCapabilityCache();
  if (!cached || !Array.isArray(cached.versions) || !cached.versions.includes(version)) return false;
  return writeCapabilityCache({ ...cached, versions: cached.versions.filter((listed) => listed !== version) });
}

/**
 * For status/debug only: state, staleness, ages, and the negotiated body
 * version. No endpoint, no advertised list, no key.
 */
function capabilityDiagnostics(now = Date.now()) {
  const snapshot = readCapabilityCache({ now });
  if (!snapshot) return { state: 'unknown', stale: true, lastSuccessAgeMs: null, checkedAgeMs: null, version: null };
  const lastSuccessAgeMs = Number.isFinite(Date.parse(snapshot.last_success_at))
    ? now - Date.parse(snapshot.last_success_at)
    : null;
  const checkedAgeMs = Number.isFinite(Date.parse(snapshot.checked_at))
    ? now - Date.parse(snapshot.checked_at)
    : null;
  const stale = lastSuccessAgeMs === null || lastSuccessAgeMs > CAPABILITY_MAX_STALE_MS;
  return {
    state: snapshot.state, stale, lastSuccessAgeMs, checkedAgeMs, version: negotiatedEvidenceVersion(snapshot),
  };
}

module.exports = {
  CAPABILITY_REFRESH_INTERVAL_MS,
  CAPABILITY_MAX_STALE_MS,
  CAPABILITY_REQUEST_TIMEOUT_MS,
  CAPABILITY_MAX_RESPONSE_BYTES,
  CAPABILITY_CACHE_SCHEMA,
  CAPABILITY_STATES,
  readCapabilityCache,
  refreshCapability,
  capabilityAllowsEvidence,
  capabilityAllowsCapture,
  captureClosedReason,
  currentBindingDigest,
  negotiatedEvidenceVersion,
  markCapabilityWithdrawn,
  markCapabilityProtocolError,
  markCapabilityAuthError,
  markCapabilityVersionRejected,
  capabilityDiagnostics,
};
