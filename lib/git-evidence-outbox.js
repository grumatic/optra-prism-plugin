'use strict';

/**
 * Dedicated spool for `git-evidence/v1` reports. Structurally parallel to
 * `lib/response-outbox.js` (deterministic filename, link + atomic rename
 * publish, orphan-temp reaper, terminal lock file) but with its own
 * directories, its own quotas, and one behavioural difference: a pending
 * entry is never evicted to make room for another. A full, failing, or
 * unreachable evidence queue never touches prompt or response capture.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDebug } = require('./debug');
const { canonicalJson } = require('./git-evidence-contract');

const MAX_EVIDENCE_ENTRY_BYTES = 589824;
const MAX_EVIDENCE_PENDING_ENTRIES = 2048;
const MAX_EVIDENCE_PENDING_BYTES = 67108864;
const EVIDENCE_PENDING_RETENTION_MS = 2592000000;
const MAX_EVIDENCE_TERMINAL_MARKERS = 4096;
const MAX_EVIDENCE_TERMINAL_BYTES = 4194304;
const EVIDENCE_TERMINAL_RETENTION_MS = 2592000000;
const ORPHAN_TEMP_AGE_MS = 300000;
const TERMINAL_LOCK_STALE_MS = 300000;

const debug = createDebug('git-evidence-outbox');

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'prism-optra-prism');
}

function getEvidenceOutboxDir() {
  return path.join(dataDir(), 'runtime', 'git-evidence-outbox');
}

function getEvidenceTerminalDir() {
  return path.join(dataDir(), 'runtime', 'git-evidence-terminal');
}

function entryFile(eventId) {
  return path.join(getEvidenceOutboxDir(), `${crypto.createHash('sha256').update(eventId).digest('hex')}.json`);
}

function terminalEntryFile(eventId) {
  return path.join(getEvidenceTerminalDir(), `${crypto.createHash('sha256').update(eventId).digest('hex')}.json`);
}

function reapOrphanTemps(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - ORPHAN_TEMP_AGE_MS;
  for (const name of names) {
    if (!/^\.[a-f0-9-]+\.tmp$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

function acquireTerminalLock(dir) {
  const lock = path.join(dir, '.terminal.lock');
  const open = () => {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > TERMINAL_LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {}
      try {
        const fd = fs.openSync(lock, 'wx', 0o600);
        fs.closeSync(fd);
        return true;
      } catch {
        return false;
      }
    }
  };
  return open() ? lock : null;
}

function validCorrelation(correlation) {
  return correlation
    && typeof correlation === 'object'
    && Object.keys(correlation).every((key) => [
      'sessionId', 'clientEventId', 'hostPromptId', 'serverPromptId', 'responseOperationId',
    ].includes(key))
    && typeof correlation.sessionId === 'string' && correlation.sessionId.length > 0
    && typeof correlation.clientEventId === 'string' && correlation.clientEventId.length > 0
    && (correlation.hostPromptId === undefined || typeof correlation.hostPromptId === 'string')
    && (correlation.serverPromptId === undefined || typeof correlation.serverPromptId === 'string')
    && (correlation.responseOperationId === undefined || typeof correlation.responseOperationId === 'string');
}

function validPendingEntry(entry) {
  return Boolean(
    entry
    && typeof entry === 'object'
    && typeof entry.eventId === 'string'
    && entry.eventId.length > 0
    && entry.schemaVersion === 'git-evidence/v1'
    && typeof entry.observedAt === 'string'
    && Number.isFinite(Date.parse(entry.observedAt))
    && typeof entry.createdAt === 'string'
    && Number.isFinite(Date.parse(entry.createdAt))
    && validCorrelation(entry.correlation)
    && entry.payload
    && typeof entry.payload === 'object'
    && entry.payload.event_id === entry.eventId
    && entry.payload.schema_version === entry.schemaVersion
    && Number.isSafeInteger(entry.deliveryAttempts)
    && entry.deliveryAttempts >= 0
    && typeof entry.nextAttemptAt === 'string'
    && Number.isFinite(Date.parse(entry.nextAttemptAt)),
  );
}

function validTerminalMarker(marker) {
  return Boolean(
    marker
    && typeof marker === 'object'
    && typeof marker.eventId === 'string'
    && marker.eventId.length > 0
    && marker.schemaVersion === 'git-evidence/v1'
    && validCorrelation(marker.correlation)
    && typeof marker.reason === 'string'
    && ['local_capacity_full', 'local_entry_oversized', 'local_retention_expired', 'permanent_http_rejection', 'event_conflict'].includes(marker.reason)
    && typeof marker.createdAt === 'string'
    && Number.isFinite(Date.parse(marker.createdAt))
    && typeof marker.terminalAt === 'string'
    && Number.isFinite(Date.parse(marker.terminalAt))
    && typeof marker.payloadHash === 'string'
    && /^[a-f0-9]{64}$/.test(marker.payloadHash),
  );
}

function readPendingEntry(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validPendingEntry(entry)) throw new TypeError('invalid evidence entry');
    return entry;
  } catch {
    return null;
  }
}

function readTerminalMarker(file) {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validTerminalMarker(marker)) throw new TypeError('invalid evidence terminal marker');
    return marker;
  } catch {
    return null;
  }
}

function pendingFiles() {
  try {
    return fs.readdirSync(getEvidenceOutboxDir())
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => path.join(getEvidenceOutboxDir(), name));
  } catch {
    return [];
  }
}

function terminalFiles() {
  try {
    return fs.readdirSync(getEvidenceTerminalDir())
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => path.join(getEvidenceTerminalDir(), name));
  } catch {
    return [];
  }
}

function pendingFilesWithStats() {
  return pendingFiles().map((file) => {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    return { file, size };
  });
}

function serializedEntryBytes(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8');
  } catch {
    return null;
  }
}

function sameEntry(left, right) {
  if (!validPendingEntry(left) || !validPendingEntry(right)) return false;
  return canonicalJson(left.payload) === canonicalJson(right.payload)
    && left.correlation.sessionId === right.correlation.sessionId
    && left.correlation.clientEventId === right.correlation.clientEventId;
}

function markerFromEntry(entry, reason, now = new Date().toISOString()) {
  return {
    eventId: entry.eventId,
    schemaVersion: entry.schemaVersion,
    correlation: entry.correlation,
    reason,
    createdAt: entry.createdAt,
    terminalAt: now,
    payloadHash: crypto.createHash('sha256').update(canonicalJson(entry.payload), 'utf8').digest('hex'),
  };
}

function writeTerminalMarker(marker) {
  const dir = getEvidenceTerminalDir();
  const file = terminalEntryFile(marker.eventId);
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  let lock;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireTerminalLock(dir);
    if (!lock) return false;
    reapOrphanTemps(dir);
    if (fs.existsSync(file)) return true;
    reserveTerminalSpaceLocked(Buffer.byteLength(JSON.stringify(marker), 'utf8'));
    fs.writeFileSync(temp, JSON.stringify(marker), { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    return true;
  } catch (err) {
    debug(`ERROR evidence terminal write: ${(err && err.code) || 'unknown'}`);
    return false;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
    if (lock) {
      try { fs.unlinkSync(lock); } catch {}
    }
  }
}

function pruneExpiredTerminalMarkersLocked(nowMs = Date.now()) {
  const cutoff = nowMs - EVIDENCE_TERMINAL_RETENTION_MS;
  for (const file of terminalFiles()) {
    const marker = readTerminalMarker(file);
    // A marker's own terminalAt is the retention authority, not file mtime
    // (which a filesystem copy, backup restore, or clock skew can disturb
    // independently of when the marker was actually written). An unreadable
    // marker falls back to mtime so a corrupt file still ages out.
    const terminalAtMs = marker ? Date.parse(marker.terminalAt) : NaN;
    const ageMs = Number.isFinite(terminalAtMs) ? terminalAtMs : (() => {
      try { return fs.statSync(file).mtimeMs; } catch { return nowMs; }
    })();
    try {
      if (ageMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

// Reduce the terminal namespace to fit one more marker of incomingBytes,
// evicting expired markers first and only then the oldest by terminalAt.
// Never touches pending evidence.
function reserveTerminalSpaceLocked(incomingBytes) {
  pruneExpiredTerminalMarkersLocked();
  const entries = terminalFiles().map((file) => {
    const marker = readTerminalMarker(file);
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    return { file, size, terminalAt: marker ? marker.terminalAt : new Date(0).toISOString() };
  }).sort((a, b) => a.terminalAt.localeCompare(b.terminalAt) || a.file.localeCompare(b.file));
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (entries.length >= MAX_EVIDENCE_TERMINAL_MARKERS || totalBytes + incomingBytes > MAX_EVIDENCE_TERMINAL_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    try {
      fs.unlinkSync(oldest.file);
      totalBytes -= oldest.size;
    } catch {
      break;
    }
  }
}

/** Converts, does not silently delete: an expired pending entry becomes a `local_retention_expired` marker. */
function pruneExpiredEvidence({ now = Date.now() } = {}) {
  const cutoff = now - EVIDENCE_PENDING_RETENTION_MS;
  let expired = 0;
  for (const { file } of pendingFilesWithStats()) {
    const entry = readPendingEntry(file);
    if (!entry) continue;
    if (Date.parse(entry.createdAt) >= cutoff) continue;
    if (writeTerminalMarker(markerFromEntry(entry, 'local_retention_expired', new Date(now).toISOString()))) {
      try {
        fs.unlinkSync(file);
        expired += 1;
      } catch {}
    }
  }
  return { expired };
}

/**
 * @param {{eventId, schemaVersion, observedAt, createdAt, correlation, payload}} entry
 * @returns {{outcome: 'created'|'existing'|'conflict'|'oversized'|'capacity_full'|'io_error'|'invalid'}}
 */
function enqueueEvidence(entry) {
  const normalized = {
    ...entry,
    deliveryAttempts: 0,
    nextAttemptAt: entry && entry.nextAttemptAt ? entry.nextAttemptAt : new Date().toISOString(),
  };
  if (!validPendingEntry(normalized)) return { outcome: 'invalid' };

  const serialized = JSON.stringify(normalized);
  const serializedBytes = Buffer.byteLength(serialized, 'utf8');
  if (serializedBytes > MAX_EVIDENCE_ENTRY_BYTES) {
    writeTerminalMarker(markerFromEntry(normalized, 'local_entry_oversized'));
    return { outcome: 'oversized' };
  }

  const dir = getEvidenceOutboxDir();
  const file = entryFile(normalized.eventId);
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    reapOrphanTemps(dir);

    if (!fs.existsSync(file)) {
      const stats = pendingFilesWithStats();
      const totalBytes = stats.reduce((sum, item) => sum + item.size, 0) + serializedBytes;
      let overCap = stats.length + 1 > MAX_EVIDENCE_PENDING_ENTRIES || totalBytes > MAX_EVIDENCE_PENDING_BYTES;
      if (overCap) {
        pruneExpiredEvidence();
        const rechecked = pendingFilesWithStats();
        const recheckedBytes = rechecked.reduce((sum, item) => sum + item.size, 0) + serializedBytes;
        overCap = rechecked.length + 1 > MAX_EVIDENCE_PENDING_ENTRIES || recheckedBytes > MAX_EVIDENCE_PENDING_BYTES;
      }
      if (overCap) {
        writeTerminalMarker(markerFromEntry(normalized, 'local_capacity_full'));
        return { outcome: 'capacity_full' };
      }
    }

    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      const existing = readPendingEntry(file);
      if (existing && sameEntry(existing, normalized)) return { outcome: 'existing' };
      if (existing) return { outcome: 'conflict' };
      const quarantine = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.corrupt`);
      fs.renameSync(file, quarantine);
      fs.linkSync(temp, file);
    }
    const published = readPendingEntry(file);
    if (!published || !sameEntry(published, normalized)) return { outcome: 'io_error' };
    return { outcome: 'created' };
  } catch (err) {
    debug(`ERROR evidence enqueue: ${(err && err.code) || 'unknown'}`);
    return { outcome: 'io_error' };
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

/** Ordered by (nextAttemptAt, observedAt, eventId). File mtime is never an ordering authority. */
function listPendingEvidence({ now = Date.now(), eligibleOnly = false } = {}) {
  const entries = pendingFiles()
    .map((file) => readPendingEntry(file))
    .filter(Boolean);
  const filtered = eligibleOnly ? entries.filter((entry) => Date.parse(entry.nextAttemptAt) <= now) : entries;
  return filtered.sort((a, b) => (
    a.nextAttemptAt.localeCompare(b.nextAttemptAt)
    || a.observedAt.localeCompare(b.observedAt)
    || a.eventId.localeCompare(b.eventId)
  ));
}

function markEvidenceDelivered(eventId) {
  if (typeof eventId !== 'string' || eventId.length === 0) return false;
  try {
    fs.unlinkSync(entryFile(eventId));
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'ENOENT');
  }
}

// Durably records one more failed delivery attempt, advancing nextAttemptAt
// per the backoff schedule in lib/git-evidence-delivery.js (required lazily
// to avoid a load-order dependency between the two modules). Best-effort: a
// lost bump only means the entry keeps its prior schedule, never that
// delivery itself fails.
function recordEvidenceAttempt(entry, { now = Date.now(), retryAfterSeconds } = {}) {
  const file = entryFile(entry.eventId);
  if (!fs.existsSync(file)) return null;
  const { nextAttemptAt } = require('./git-evidence-delivery');
  const attempts = Number.isSafeInteger(entry.deliveryAttempts) ? entry.deliveryAttempts : 0;
  const next = {
    ...entry,
    deliveryAttempts: attempts + 1,
    nextAttemptAt: nextAttemptAt({ ...entry, deliveryAttempts: attempts }, { now, retryAfterSeconds }),
  };
  if (!validPendingEntry(next)) return null;
  const serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_ENTRY_BYTES) return null;
  const dir = getEvidenceOutboxDir();
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    if (!fs.existsSync(file)) return null;
    fs.renameSync(temp, file);
    return next;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function evidenceCounts() {
  const pendingStats = pendingFilesWithStats();
  const pendingBytes = pendingStats.reduce((sum, item) => sum + item.size, 0);
  const terminalReasons = {};
  let terminalBytes = 0;
  let terminalCount = 0;
  for (const file of terminalFiles()) {
    const marker = readTerminalMarker(file);
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    terminalBytes += size;
    terminalCount += 1;
    if (marker) terminalReasons[marker.reason] = (terminalReasons[marker.reason] || 0) + 1;
  }
  return {
    pending: pendingStats.length,
    pendingBytes,
    terminal: terminalCount,
    terminalBytes,
    terminalReasons,
  };
}

/**
 * Publish a terminal marker for an entry and remove its pending file, once.
 * @returns {{state: 'terminal'|'conflict'|'io_error'|'absent'}}
 */
function settleEvidenceTerminal(entry, reason) {
  const file = entryFile(entry.eventId);
  const marker = markerFromEntry(entry, reason);
  const terminalFile = terminalEntryFile(entry.eventId);
  if (fs.existsSync(terminalFile)) {
    const existing = readTerminalMarker(terminalFile);
    if (!existing) return { state: 'io_error' };
    if (existing.payloadHash !== marker.payloadHash) return { state: 'conflict' };
    markEvidenceDelivered(entry.eventId);
    return { state: 'terminal' };
  }
  if (!fs.existsSync(file)) return { state: 'absent' };
  if (!writeTerminalMarker(marker)) return { state: 'io_error' };
  markEvidenceDelivered(entry.eventId);
  return { state: 'terminal' };
}

module.exports = {
  MAX_EVIDENCE_ENTRY_BYTES,
  MAX_EVIDENCE_PENDING_ENTRIES,
  MAX_EVIDENCE_PENDING_BYTES,
  EVIDENCE_PENDING_RETENTION_MS,
  MAX_EVIDENCE_TERMINAL_MARKERS,
  MAX_EVIDENCE_TERMINAL_BYTES,
  EVIDENCE_TERMINAL_RETENTION_MS,
  ORPHAN_TEMP_AGE_MS,
  TERMINAL_LOCK_STALE_MS,
  getEvidenceOutboxDir,
  getEvidenceTerminalDir,
  enqueueEvidence,
  listPendingEvidence,
  markEvidenceDelivered,
  recordEvidenceAttempt,
  settleEvidenceTerminal,
  pruneExpiredEvidence,
  evidenceCounts,
  serializedEntryBytes,
  entryFile,
  terminalEntryFile,
};
