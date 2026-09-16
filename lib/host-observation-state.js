/**
 * Small durable per-session state for host observation collection:
 *  - which outbox kinds an old ingest deployment has told this session it
 *    does not support (contract §5.4 — recorded once, never retried again);
 *  - the hook `source` this session's UserPromptSubmit recorded for a given
 *    host_prompt_id, needed again later at Stop or the next UserPromptSubmit
 *    once the original hook input is no longer in hand;
 *  - the next stop_context ordinal for a given host_prompt_id.
 *
 * This is best-effort auxiliary state, not a correlation source of truth: a
 * lost or corrupt file only degrades observation completeness (a duplicate
 * stop_ordinal collides on the server as a semantic-hash conflict and is
 * simply not retried; a forgotten "unsupported" mark just costs one more
 * terminal 404/405 round trip). It never affects prompt/response delivery.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDebug } = require('./debug');

const debug = createDebug('host-observation-state');

// Bounds how many distinct host_prompt_id keys are retained per map, so a
// very long-lived session cannot grow this file without bound. Oldest
// insertion is dropped first.
const MAX_TRACKED_PROMPT_IDS = 64;
const SCHEMA_VERSION = 1;

function getStateDir() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'prism-optra-prism');
  return path.join(dataDir, 'runtime', 'host-observation-state');
}

function stateFile(sessionId) {
  return path.join(getStateDir(), `${crypto.createHash('sha256').update(sessionId).digest('hex')}.json`);
}

function defaultState(sessionId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    unsupportedKinds: [],
    hookSourceByHostPromptId: {},
    hookSourceOrder: [],
    stopOrdinalByHostPromptId: {},
    stopOrdinalOrder: [],
  };
}

function isValidState(value, sessionId) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.schemaVersion === SCHEMA_VERSION
    && value.sessionId === sessionId
    && Array.isArray(value.unsupportedKinds)
    && value.unsupportedKinds.every((kind) => typeof kind === 'string')
    && value.hookSourceByHostPromptId
    && typeof value.hookSourceByHostPromptId === 'object'
    && Array.isArray(value.hookSourceOrder)
    && value.stopOrdinalByHostPromptId
    && typeof value.stopOrdinalByHostPromptId === 'object'
    && Array.isArray(value.stopOrdinalOrder),
  );
}

function readState(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return defaultState(sessionId || '');
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
    return isValidState(value, sessionId) ? value : defaultState(sessionId);
  } catch {
    return defaultState(sessionId);
  }
}

// Atomic best-effort write. A failure here is swallowed by every caller: this
// state is a convenience cache, never a durability guarantee.
function writeState(sessionId, state) {
  const dir = getStateDir();
  const file = stateFile(sessionId);
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
    return true;
  } catch (err) {
    debug(`ERROR host-observation-state write: ${(err && err.code) || 'unknown'}`);
    return false;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function boundedInsert(map, order, key, value) {
  if (!Object.hasOwn(map, key)) order.push(key);
  map[key] = value;
  while (order.length > MAX_TRACKED_PROMPT_IDS) {
    const oldest = order.shift();
    delete map[oldest];
  }
}

function markKindUnsupported(sessionId, kind) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof kind !== 'string') return false;
  const state = readState(sessionId);
  if (state.unsupportedKinds.includes(kind)) return true;
  state.unsupportedKinds.push(kind);
  return writeState(sessionId, state);
}

function isKindUnsupported(sessionId, kind) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  return readState(sessionId).unsupportedKinds.includes(kind);
}

function recordHookSource(sessionId, hostPromptId, source) {
  if (
    typeof sessionId !== 'string' || sessionId.length === 0
    || typeof hostPromptId !== 'string' || hostPromptId.length === 0
  ) return false;
  const state = readState(sessionId);
  boundedInsert(state.hookSourceByHostPromptId, state.hookSourceOrder, hostPromptId, source ?? null);
  return writeState(sessionId, state);
}

function readHookSource(sessionId, hostPromptId) {
  if (
    typeof sessionId !== 'string' || sessionId.length === 0
    || typeof hostPromptId !== 'string' || hostPromptId.length === 0
  ) return null;
  const value = readState(sessionId).hookSourceByHostPromptId[hostPromptId];
  return typeof value === 'string' ? value : null;
}

// Allocates and durably persists the next 0-based stop_context ordinal for a
// host_prompt_id, so repeated Stop invocations for the same prompt (retries,
// continuation) each get a distinct, deterministic id.
function nextStopOrdinal(sessionId, hostPromptId) {
  if (
    typeof sessionId !== 'string' || sessionId.length === 0
    || typeof hostPromptId !== 'string' || hostPromptId.length === 0
  ) return 0;
  const state = readState(sessionId);
  const current = Number.isSafeInteger(state.stopOrdinalByHostPromptId[hostPromptId])
    ? state.stopOrdinalByHostPromptId[hostPromptId]
    : 0;
  boundedInsert(state.stopOrdinalByHostPromptId, state.stopOrdinalOrder, hostPromptId, current + 1);
  writeState(sessionId, state);
  return current;
}

module.exports = {
  MAX_TRACKED_PROMPT_IDS,
  markKindUnsupported,
  isKindUnsupported,
  recordHookSource,
  readHookSource,
  nextStopOrdinal,
};
