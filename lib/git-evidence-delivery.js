'use strict';

/**
 * `git-evidence/v1` delivery: the HTTP disposition table, retry schedule,
 * and drain loop for the dedicated evidence spool.
 */

const crypto = require('crypto');
const {
  GIT_EVIDENCE_SCHEMA_VERSION,
  GIT_EVIDENCE_BODY_TOO_LARGE_TEXT,
  GIT_EVIDENCE_ERROR_CODES,
  MAX_GIT_EVIDENCE_RESPONSE_BYTES,
} = require('./git-evidence-contract');
const {
  pruneExpiredEvidence,
  listPendingEvidence,
  markEvidenceDelivered,
  recordEvidenceAttempt,
  settleEvidenceTerminal,
} = require('./git-evidence-outbox');
const { createDebug } = require('./debug');

const debug = createDebug('git-evidence-delivery');

const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 21600000;
const RETRY_AFTER_MIN_SECONDS = 1;
const RETRY_AFTER_MAX_SECONDS = 3600;
const SESSION_START_DRAIN_LIMIT = 8;
const SESSION_START_DRAIN_ELAPSED_MS = 750;
const STOP_DRAIN_LIMIT = 1;
const STOP_DRAIN_ELAPSED_MS = 500;
const EVIDENCE_REQUEST_TIMEOUT_MS = 3000;

const TERMINAL_PERMANENT_CODES = new Set([
  'git_evidence_invalid_payload',
  'git_evidence_disallowed_field',
  'git_evidence_commit_limit_exceeded',
]);

function isCappedJsonBody(result) {
  return Boolean(
    result
    && result.mediaType === 'application/json'
    && result.bodyTruncated !== true
    && Number.isSafeInteger(result.bodyBytes)
    && result.bodyBytes <= MAX_GIT_EVIDENCE_RESPONSE_BYTES,
  );
}

function parseAckStatus(result, entry) {
  if (!isCappedJsonBody(result)) return null;
  let body;
  try {
    body = JSON.parse(result.body);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 3 || !['event_id', 'schema_version', 'status'].every((key) => keys.includes(key))) return null;
  if (body.event_id !== entry.eventId) return null;
  if (body.schema_version !== GIT_EVIDENCE_SCHEMA_VERSION) return null;
  return typeof body.status === 'string' ? body.status : null;
}

function parseCodedErrorBody(result) {
  if (!isCappedJsonBody(result)) return null;
  let body;
  try {
    body = JSON.parse(result.body);
  } catch {
    return null;
  }
  const shaped = body
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.keys(body).length === 1
    && body.error
    && typeof body.error === 'object'
    && !Array.isArray(body.error)
    && Object.keys(body.error).length === 1
    && typeof body.error.code === 'string';
  if (!shaped || !GIT_EVIDENCE_ERROR_CODES.includes(body.error.code)) return null;
  return body.error.code;
}

/**
 * Pure. Exported for direct table testing. `disposition` is one of:
 * 'ack', 'terminal_permanent', 'terminal_conflict', 'retry',
 * 'pause_auth', 'pause_withdrawn', 'pause_protocol'.
 */
function classifyEvidenceResponse(result, entry) {
  const status = result && Number.isInteger(result.status) ? result.status : 0;

  if (status === 202) return parseAckStatus(result, entry) === 'accepted' ? 'ack' : 'pause_protocol';
  if (status === 200) return parseAckStatus(result, entry) === 'duplicate' ? 'ack' : 'pause_protocol';

  if (status === 400) {
    const code = parseCodedErrorBody(result);
    if (code === 'git_evidence_unsupported_schema') return 'pause_protocol';
    return code && TERMINAL_PERMANENT_CODES.has(code) ? 'terminal_permanent' : 'pause_protocol';
  }
  if (status === 409) {
    return parseCodedErrorBody(result) === 'git_evidence_event_conflict' ? 'terminal_conflict' : 'pause_protocol';
  }
  if (status === 413) {
    return (result.mediaType === 'text/plain' && result.bodyTruncated !== true && result.body === GIT_EVIDENCE_BODY_TOO_LARGE_TEXT)
      ? 'terminal_permanent'
      : 'pause_protocol';
  }
  if (status === 415) {
    return parseCodedErrorBody(result) === 'git_evidence_unsupported_media_type' ? 'terminal_permanent' : 'pause_protocol';
  }
  if (status === 401 || status === 403) return 'pause_auth';
  if (status === 404 || status === 410) return 'pause_withdrawn';
  if (status === 408 || status === 425 || status === 429 || status === 0 || (status >= 500 && status < 600)) return 'retry';
  return 'pause_protocol';
}

/** Pure. Exported for deterministic backoff testing. */
function nextAttemptAt(entry, { now = Date.now(), retryAfterSeconds } = {}) {
  const priorAttempts = Number.isSafeInteger(entry.deliveryAttempts) ? entry.deliveryAttempts : 0;
  const n = Math.min(priorAttempts + 1, 40);
  const delay = Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS);
  const digest = crypto.createHash('sha256').update(String(entry.eventId), 'utf8').digest();
  const u32 = digest.readUInt32BE(0);
  const jitter = 0.8 + (u32 / 4294967295) * 0.4;
  let target = now + Math.round(delay * jitter);
  if (
    Number.isInteger(retryAfterSeconds)
    && retryAfterSeconds >= RETRY_AFTER_MIN_SECONDS
    && retryAfterSeconds <= RETRY_AFTER_MAX_SECONDS
  ) {
    target = Math.max(target, now + retryAfterSeconds * 1000);
  }
  return new Date(target).toISOString();
}

function pauseStateFor(disposition) {
  if (disposition === 'pause_auth') return 'auth_error';
  if (disposition === 'pause_withdrawn') return 'withdrawn';
  return 'protocol_error';
}

function publishCapabilityPause(pauseState) {
  const {
    markCapabilityAuthError,
    markCapabilityWithdrawn,
    markCapabilityProtocolError,
  } = require('./git-evidence-capability');
  if (pauseState === 'auth_error') return markCapabilityAuthError();
  if (pauseState === 'withdrawn') return markCapabilityWithdrawn();
  return markCapabilityProtocolError();
}

/** POST one entry. Returns the classified disposition; never throws. */
async function deliverEvidenceEntry(entry, { deadline } = {}) {
  const { sendGitEvidence } = require('./ingest');
  let result;
  try {
    result = await sendGitEvidence(entry.payload, {
      timeoutMs: EVIDENCE_REQUEST_TIMEOUT_MS,
      ...(deadline === undefined ? {} : { deadline }),
    });
  } catch (error) {
    debug(`ERROR evidence send: id=${entry.eventId} code=${(error && error.code) || 'unknown'}`);
    result = { status: 0 };
  }

  const disposition = classifyEvidenceResponse(result, entry);
  const base = {
    eventId: entry.eventId, disposition, result,
  };

  if (disposition === 'ack') {
    markEvidenceDelivered(entry.eventId);
    return {
      ...base, acked: true, terminal: false, terminalReason: null, paused: false, pauseState: null,
    };
  }

  if (disposition === 'terminal_permanent' || disposition === 'terminal_conflict') {
    const reason = disposition === 'terminal_conflict' ? 'event_conflict' : 'permanent_http_rejection';
    const settled = settleEvidenceTerminal(entry, reason);
    // A local settle failure (conflict / io_error / absent) is not itself a
    // disposition the server can be blamed for again: advance the backoff
    // schedule so this entry is not resent to the ingest service on every
    // single drain pass while the local settle keeps failing.
    if (settled.state !== 'terminal') {
      recordEvidenceAttempt(entry, { now: Date.now() });
    }
    return {
      ...base,
      acked: false,
      terminal: settled.state === 'terminal',
      terminalReason: settled.state === 'terminal' ? reason : null,
      paused: false,
      pauseState: null,
    };
  }

  if (disposition === 'pause_auth' || disposition === 'pause_withdrawn' || disposition === 'pause_protocol') {
    const pauseState = pauseStateFor(disposition);
    publishCapabilityPause(pauseState);
    return {
      ...base, acked: false, terminal: false, terminalReason: null, paused: true, pauseState,
    };
  }

  recordEvidenceAttempt(entry, {
    now: Date.now(),
    retryAfterSeconds: result && Number.isInteger(result.retryAfterSeconds) ? result.retryAfterSeconds : null,
  });
  return {
    ...base, acked: false, terminal: false, terminalReason: null, paused: false, pauseState: null,
  };
}

async function drainEvidence({ limit = Infinity, maxElapsedMs = Infinity, prioritizeIds = [] } = {}) {
  pruneExpiredEvidence();

  const { readCapabilityCache, capabilityAllowsEvidence } = require('./git-evidence-capability');
  if (!capabilityAllowsEvidence(readCapabilityCache())) return [];

  const deadline = Number.isFinite(maxElapsedMs) ? Date.now() + maxElapsedMs : undefined;
  const now = Date.now();
  const eligible = listPendingEvidence({ now, eligibleOnly: true });
  const prioritizedSet = new Set(Array.isArray(prioritizeIds) ? prioritizeIds : []);
  const prioritized = [];
  const rest = [];
  for (const entry of eligible) (prioritizedSet.has(entry.eventId) ? prioritized : rest).push(entry);
  const ordered = [...prioritized, ...rest];

  const outcomes = [];
  let sent = 0;
  for (const entry of ordered) {
    if (sent >= limit) break;
    if (deadline !== undefined && Date.now() > deadline) break;
    const outcome = await deliverEvidenceEntry(entry, { deadline });
    outcomes.push(outcome);
    sent += 1;
    // The first pause publishes a capability transition every remaining
    // entry would receive the same answer for — stop the drain there.
    if (outcome.paused) break;
  }
  return outcomes;
}

module.exports = {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RETRY_AFTER_MIN_SECONDS,
  RETRY_AFTER_MAX_SECONDS,
  SESSION_START_DRAIN_LIMIT,
  SESSION_START_DRAIN_ELAPSED_MS,
  STOP_DRAIN_LIMIT,
  STOP_DRAIN_ELAPSED_MS,
  EVIDENCE_REQUEST_TIMEOUT_MS,
  classifyEvidenceResponse,
  nextAttemptAt,
  deliverEvidenceEntry,
  drainEvidence,
};
