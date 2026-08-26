/**
 * Small durable queue for ingest intents that must survive hook process exits.
 * Entries are independently idempotent at the ingest service.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDebug } = require('./debug');

const MAX_PENDING_ENTRIES = 512;
// A conservative cap on the whole spool's on-disk size, independent of the
// per-entry cap: 512 entries at MAX_ENTRY_BYTES each would allow well over
// 1.5 GiB in the worst case. Checked with fs.statSync sizes only (no parse)
// in reservePendingSlot, mirroring reserveTerminalSpace's byte-budget
// eviction below.
const MAX_PENDING_BYTES = 128 * 1024 * 1024;
// A clamped prompt_text/response_text field's escaped size can reach
// MAX_WIRE_BYTES (~2.9375 MiB, see lib/body-clamp.js — the larger of its two
// bounds). The entry envelope around it — ids, a 1024-char session id, a
// 1024-byte host_prompt_id, timestamps, and a handful of other short fixed
// fields — measures at most a few KiB on top, so the 128 KiB margin below is
// generous headroom, not a tight bound. Note: payload.cwd on prompt entries
// has no client-side byte cap, so an unusually long host-supplied cwd could
// still push an entry over this limit.
const MAX_ENTRY_BYTES = Math.ceil((6 * 1024 * 1024 - 128 * 1024) / 2) + 128 * 1024;
const MAX_TERMINAL_REJECTED_ENTRIES = 32;
const MAX_TERMINAL_REJECTED_BYTES = 64 * 1024 * 1024;
const TERMINAL_REJECTED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TERMINAL_RESPONSE_BODY_BYTES = 4 * 1024;
const ORPHAN_TEMP_AGE_MS = 5 * 60 * 1000;
const TERMINAL_LOCK_STALE_MS = 5 * 60 * 1000;
const debug = createDebug('response-outbox');

function getOutboxDir() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'prism-optra-prism');
  return path.join(dataDir, 'runtime', 'outbox');
}

function getTerminalRejectedDir() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'prism-optra-prism');
  return path.join(dataDir, 'runtime', 'outbox-terminal-rejected');
}

function entryFile(id) {
  return path.join(getOutboxDir(), `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
}

function terminalEntryFile(id) {
  return path.join(getTerminalRejectedDir(), `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
}

function isTerminalRejected(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  const file = terminalEntryFile(id);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs > TERMINAL_REJECTED_RETENTION_MS) return false;
  } catch {
    return false;
  }
  return Boolean(readTerminalEntry(file));
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

function validDeliveryFence(entry) {
  const fence = entry && entry.deliveryFence;
  const payload = entry && entry.payload;
  if (
    !entry
    || entry.kind !== 'response'
    || !fence
    || typeof fence !== 'object'
    || typeof fence.sessionId !== 'string'
    || fence.sessionId.length === 0
    || fence.sessionId.length > 1024
    || !Number.isSafeInteger(fence.epoch)
    || fence.epoch < 0
    || typeof fence.clientEventId !== 'string'
    || fence.clientEventId.length === 0
    || typeof fence.submitPromptId !== 'string'
    || fence.submitPromptId.length === 0
    || typeof fence.serverPromptId !== 'string'
    || fence.serverPromptId.length === 0
    || !payload
    || payload.tool_session_id !== fence.sessionId
    || payload.client_event_id !== fence.clientEventId
    || payload.host_prompt_id !== fence.submitPromptId
    || payload.prompt_id !== fence.serverPromptId
    || payload.response_operation_id !== entry.id
  ) return false;
  const operationId = crypto.createHash('sha256')
    .update(`${fence.sessionId}\n${fence.clientEventId}\n${fence.submitPromptId}`)
    .digest('hex');
  return entry.id === operationId;
}

function validEntry(entry) {
  return entry
    && typeof entry === 'object'
    && typeof entry.id === 'string'
    && entry.id.length > 0
    && entry.id.length <= 512
    && (entry.kind === 'prompt' || entry.kind === 'response' || entry.kind === 'prompt_evidence' || entry.kind === 'gap')
    && entry.payload
    && typeof entry.payload === 'object'
    && !Array.isArray(entry.payload)
    && (entry.dependsOn === undefined || (typeof entry.dependsOn === 'string' && entry.dependsOn.length > 0 && entry.dependsOn.length <= 512))
    && typeof entry.createdAt === 'string'
    && Number.isFinite(Date.parse(entry.createdAt))
    && (entry.deliveryAttempts === undefined || (Number.isSafeInteger(entry.deliveryAttempts) && entry.deliveryAttempts >= 0))
    && (entry.terminalReason === undefined || (typeof entry.terminalReason === 'string' && entry.terminalReason.length > 0 && entry.terminalReason.length <= 128))
    && (entry.promotion === undefined || (
      entry.kind === 'prompt'
      && entry.promotion
      && typeof entry.promotion === 'object'
      && typeof entry.promotion.sessionId === 'string'
      && entry.promotion.sessionId.length > 0
      && entry.promotion.sessionId.length <= 1024
      && Number.isSafeInteger(entry.promotion.epoch)
      && entry.promotion.epoch >= 0
      && typeof entry.promotion.clientEventId === 'string'
      && entry.promotion.clientEventId.length > 0
      && typeof entry.promotion.hostPromptId === 'string'
      && entry.promotion.hostPromptId.length > 0
      && (entry.promotion.identityMode === undefined || entry.promotion.identityMode === 'exact')
    ))
    && (entry.legacyPromotion === undefined || (
      entry.kind === 'prompt'
      && entry.legacyPromotion
      && typeof entry.legacyPromotion === 'object'
      && typeof entry.legacyPromotion.sessionId === 'string'
      && entry.legacyPromotion.sessionId.length > 0
      && entry.legacyPromotion.sessionId.length <= 1024
      && Number.isSafeInteger(entry.legacyPromotion.epoch)
      && entry.legacyPromotion.epoch >= 0
      && typeof entry.legacyPromotion.clientEventId === 'string'
      && entry.legacyPromotion.clientEventId.length > 0
    ))
    && (entry.deliveryFence === undefined || validDeliveryFence(entry))
    && !(entry.promotion && entry.legacyPromotion);
}

function readEntry(file) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!validEntry(entry)) throw new TypeError('invalid entry');
    return entry;
  } catch {
    debug(`SKIP corrupt outbox entry: ${path.basename(file)}`);
    return null;
  }
}

function pendingFiles() {
  try {
    return fs.readdirSync(getOutboxDir())
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => path.join(getOutboxDir(), name));
  } catch {
    return [];
  }
}

// Cheap candidate ordering: filename plus mtime, no JSON parse. Used to scan
// oldest-first without paying the parse cost of every entry's (potentially
// multi-MB) payload up front.
function pendingFilesWithStats() {
  return pendingFiles().map((file) => {
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(file);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {}
    return { file, size, mtimeMs };
  }).sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
}

function readTerminalEntry(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validEntry(value) ? value : null;
  } catch {
    return null;
  }
}

function terminalFiles() {
  try {
    return fs.readdirSync(getTerminalRejectedDir())
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => path.join(getTerminalRejectedDir(), name));
  } catch {
    return [];
  }
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
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        debug(`REAP orphan outbox temp: ${name}`);
      }
    } catch {}
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalEntry(entry) {
  try {
    return JSON.parse(JSON.stringify(entry));
  } catch {
    return null;
  }
}

function serializedEntryBytes(entry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8');
  } catch {
    return null;
  }
}

function sameEntry(left, right) {
  const normalizedLeft = canonicalEntry(left);
  const normalizedRight = canonicalEntry(right);
  if (!validEntry(normalizedLeft) || !validEntry(normalizedRight)) return false;
  const leftIntent = { ...normalizedLeft };
  const rightIntent = { ...normalizedRight };
  delete leftIntent.createdAt;
  delete rightIntent.createdAt;
  // deliveryAttempts is a mutable delivery-order hint, not part of the
  // durable intent identity — a re-enqueue of the same intent must still
  // match a copy this module has since bumped in place (see bumpDeliveryAttempts).
  delete leftIntent.deliveryAttempts;
  delete rightIntent.deliveryAttempts;
  // Receipt settlement is mutable local state. A first terminal reason is
  // retained; a replay that reaches a differently worded equivalent terminal
  // receipt must not turn its existing tombstone into a conflict.
  delete leftIntent.terminalReason;
  delete rightIntent.terminalReason;
  if (leftIntent.kind === 'prompt_evidence' && rightIntent.kind === 'prompt_evidence') {
    if (leftIntent.payload && leftIntent.payload.producer_evidence) delete leftIntent.payload.producer_evidence.observed_at;
    if (rightIntent.payload && rightIntent.payload.producer_evidence) delete rightIntent.payload.producer_evidence.observed_at;
  }
  return stableJson(normalizedLeft) === stableJson(normalizedRight)
    || stableJson(leftIntent) === stableJson(rightIntent);
}

// incomingBytes is the serialized size of the entry about to be written, so
// the byte budget accounts for it before it exists on disk.
function reservePendingSlot(incomingBytes) {
  const files = pendingFilesWithStats(); // cheap: stat only, no parse
  const incoming = Number.isSafeInteger(incomingBytes) && incomingBytes >= 0 ? incomingBytes : 0;
  let totalBytes = files.reduce((sum, f) => sum + f.size, 0) + incoming;
  const requiredCountEvictions = files.length - MAX_PENDING_ENTRIES + 1;
  const overByteBudget = () => totalBytes > MAX_PENDING_BYTES;
  if (requiredCountEvictions <= 0 && !overByteBudget()) return true;

  // Eviction order is the entry's own createdAt, not file mtime: mtime is a
  // fine proxy for drain()'s send-order (least-recently-attempted-first is
  // benign there), but bumpDeliveryAttempts refreshes mtime on every failed
  // attempt, so a chronically-failing entry would otherwise keep promoting
  // itself to "newest" and be evicted last, ahead of fresh, still-deliverable
  // prompts. Eviction only runs once the spool is actually near a cap, so
  // parsing every candidate here (unlike the stat-only pass above) is
  // acceptable.
  const parsed = files
    .map(({ file, size }) => ({ file, size, entry: readEntry(file) }))
    .filter((candidate) => candidate.entry)
    .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.file.localeCompare(b.file));

  // Responses are the sole durable record after Stop consumes a turn. Evidence
  // is lowest-priority telemetry: evict it first, then prompts, never a
  // response intent.
  let evicted = 0;
  for (const evictKind of ['prompt_evidence', 'prompt']) {
    for (const { file, size, entry } of parsed) {
      if (evicted >= requiredCountEvictions && !overByteBudget()) break;
      if (entry.kind !== evictKind) continue;
      if (evictKind === 'prompt_evidence') {
        const settled = settleTerminal({ ...entry, terminalReason: 'outbox_evicted_capacity' }, true);
        if (settled.state !== 'terminal' || !settled.primaryRemoved) {
          debug(`ERROR outbox evidence eviction tombstone: ${path.basename(file)}`);
          continue;
        }
        evicted += 1;
        totalBytes -= size;
        debug(`DROP outbox ${evictKind} beyond cap: ${path.basename(file)}`);
      } else {
        try {
          fs.unlinkSync(file);
          evicted += 1;
          totalBytes -= size;
          debug(`DROP outbox ${evictKind} beyond cap: ${path.basename(file)}`);
        } catch {}
      }
    }
  }
  if (evicted < requiredCountEvictions) {
    debug('ERROR outbox full: preserving unacknowledged response intents');
    return false;
  }
  if (overByteBudget()) {
    debug('ERROR outbox byte cap exceeded: preserving unacknowledged response intents');
    return false;
  }
  return true;
}

function pruneExpiredTerminalEntriesLocked(nowMs = Date.now()) {
  const cutoff = nowMs - TERMINAL_REJECTED_RETENTION_MS;
  for (const file of terminalFiles()) {
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}

function pruneExpiredTerminalEntries() {
  const dir = getTerminalRejectedDir();
  if (!fs.existsSync(dir)) return;
  const lock = acquireTerminalLock(dir);
  if (!lock) return;
  try {
    reapOrphanTemps(dir);
    pruneExpiredTerminalEntriesLocked();
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}

function reserveTerminalSpace(serializedBytes) {
  if (serializedBytes > MAX_ENTRY_BYTES) return false;
  const nowMs = Date.now();
  pruneExpiredTerminalEntriesLocked(nowMs);
  const entries = terminalFiles().map((file) => {
    let size = 0;
    let rejectedAtMs = Number.NEGATIVE_INFINITY;
    try { size = fs.statSync(file).size; } catch {}
    try { rejectedAtMs = fs.statSync(file).mtimeMs; } catch {}
    return {
      file,
      size,
      rejectedAtMs,
    };
  });
  let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  entries.sort((left, right) => left.rejectedAtMs - right.rejectedAtMs || left.file.localeCompare(right.file));
  while (entries.length >= MAX_TERMINAL_REJECTED_ENTRIES || totalBytes + serializedBytes > MAX_TERMINAL_REJECTED_BYTES) {
    const oldest = entries.shift();
    if (!oldest) return false;
    try {
      fs.unlinkSync(oldest.file);
      totalBytes -= oldest.size;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Publish a send intent without replacing an already published intent with the
 * same deterministic id.
 * @param {{ id: string, kind: 'prompt'|'response'|'prompt_evidence', payload: object, dependsOn?: string, createdAt?: string, promotion?: object, legacyPromotion?: object }} entry
 * @returns {{outcome: 'created'|'existing'|'conflict'|'oversized'|'capacity_full'|'io_error'|'invalid'}}
 */
function enqueueDetailed(entry) {
  const normalized = { ...entry, createdAt: entry && entry.createdAt ? entry.createdAt : new Date().toISOString() };
  if (!validEntry(normalized)) {
    debug('SKIP invalid outbox enqueue');
    return { outcome: 'invalid' };
  }

  const serialized = JSON.stringify(normalized);
  if (serializedEntryBytes(normalized) > MAX_ENTRY_BYTES) {
    debug(`SKIP oversized outbox entry: id=${normalized.id}`);
    return { outcome: 'oversized' };
  }

  const dir = getOutboxDir();
  const file = entryFile(normalized.id);
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    reapOrphanTemps(dir);
    if (!fs.existsSync(file) && !reservePendingSlot(Buffer.byteLength(serialized, 'utf8'))) return { outcome: 'capacity_full' };
    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      const existing = readEntry(file);
      if (sameEntry(existing, normalized)) {
        // The existing final is already this exact durable publication.
        return { outcome: 'existing' };
      } else if (existing) {
        debug(`ERROR outbox enqueue: conflicting final id=${normalized.id}`);
        return { outcome: 'conflict' };
      } else {
        const quarantine = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.corrupt`);
        fs.renameSync(file, quarantine);
        fs.linkSync(temp, file);
      }
    }
    const published = readEntry(file);
    if (!sameEntry(published, normalized)) {
      debug(`ERROR outbox enqueue: final validation failed id=${normalized.id}`);
      return { outcome: 'io_error' };
    }
    return { outcome: 'created' };
  } catch (err) {
    debug(`ERROR outbox enqueue: ${(err && err.code) || 'unknown'}`);
    return { outcome: 'io_error' };
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function enqueue(entry) {
  const result = enqueueDetailed(entry);
  return result.outcome === 'created' || result.outcome === 'existing';
}

function settleTerminal(entry, create) {
  // The sibling namespace identifies the rejection class; the final file's
  // mtime is the bounded rejectedAt value used for retention and eviction.
  // The HTTP body is intentionally never copied into durable storage.
  const dir = getTerminalRejectedDir();
  const file = terminalEntryFile(entry.id);
  if (!create && !fs.existsSync(file)) {
    return { state: 'absent', primaryRemoved: false, terminalReason: null };
  }
  const serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) {
    debug(`ERROR terminal outbox entry oversized: id=${entry.id}`);
    return { state: 'io_error', primaryRemoved: false, terminalReason: null };
  }
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  let lock;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireTerminalLock(dir);
    if (!lock) return { state: 'io_error', primaryRemoved: false, terminalReason: null };
    reapOrphanTemps(dir);
    pruneExpiredTerminalEntriesLocked();
    if (fs.existsSync(file)) {
      const existing = readTerminalEntry(file);
      if (!existing) return { state: 'corrupt', primaryRemoved: false, terminalReason: null };
      if (!sameEntry(existing, entry)) return { state: 'conflict', primaryRemoved: false, terminalReason: null };
      return { state: 'terminal', primaryRemoved: markAcked(entry.id), terminalReason: existing.terminalReason || null };
    } else {
      if (!create) return { state: 'absent', primaryRemoved: false, terminalReason: null };
      if (!reserveTerminalSpace(Buffer.byteLength(serialized))) return { state: 'io_error', primaryRemoved: false, terminalReason: null };
      fs.writeFileSync(temp, serialized, { mode: 0o600 });
      try {
        fs.linkSync(temp, file);
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
      }
      const published = readTerminalEntry(file);
      if (!published) return { state: 'corrupt', primaryRemoved: false, terminalReason: null };
      if (!sameEntry(published, entry)) return { state: 'conflict', primaryRemoved: false, terminalReason: null };
      return { state: 'terminal', primaryRemoved: markAcked(entry.id), terminalReason: published.terminalReason || null };
    }
  } catch (err) {
    debug(`ERROR terminal outbox write: ${(err && err.code) || 'unknown'}`);
    return { state: 'io_error', primaryRemoved: false, terminalReason: null };
  } finally {
    try { fs.unlinkSync(temp); } catch {}
    if (lock) {
      try { fs.unlinkSync(lock); } catch {}
    }
  }
}

// The closed set of machine-coded 400 rejections the ingest service
// documents as permanent. Each is rendered server-side as exactly
// {"error":{"code":...}} (AppError::BadRequestCode / InvalidHostPromptId in
// apps/ingest/src/main.rs); the codes are a shipped client contract and are
// never renamed. Retrying any of these can never succeed, so the entry is
// settled into the terminal-rejected namespace instead of redelivering
// forever.
const TERMINAL_REJECTION_CODES = new Set([
  'invalid_host_prompt_id',
  'unrecognized_source',
  'empty_prompt_text',
  'prompt_body_exceeds_limit',
  'response_body_exceeds_limit',
  'prompt_producer_evidence_invalid',
  'prompt_producer_evidence_namespace_unsupported',
  'prompt_producer_evidence_schema_unsupported',
  'prompt_producer_evidence_exceeds_limit',
  'prompt_producer_evidence_identity_mismatch',
  'prompt_evidence_invalid_json',
  'prompt_evidence_schema_unsupported',
  'prompt_evidence_namespace_unsupported',
  'prompt_evidence_evidence_schema_unsupported',
  'prompt_evidence_invalid_evidence',
  'prompt_evidence_invalid_identity',
  'prompt_evidence_invalid_hash',
  'prompt_evidence_identity_conflict',
  'prompt_evidence_exceeds_limit',
  'prompt_evidence_request_too_large',
  'prompt_evidence_unsupported_media_type',
]);

function terminalRejectionCode(result) {
  if (!result || ![400, 409, 413, 415].includes(result.status) || result.mediaType !== 'application/json') return null;
  const bodyBytes = Number.isSafeInteger(result.bodyBytes)
    ? result.bodyBytes
    : Buffer.byteLength(typeof result.body === 'string' ? result.body : '', 'utf8');
  if (result.bodyTruncated === true || bodyBytes > MAX_TERMINAL_RESPONSE_BODY_BYTES) return null;
  try {
    const body = JSON.parse(result.body);
    const shaped = body
      && typeof body === 'object'
      && !Array.isArray(body)
      && Object.keys(body).length === 1
      && body.error
      && typeof body.error === 'object'
      && !Array.isArray(body.error)
      && Object.keys(body.error).length === 1
      && typeof body.error.code === 'string';
    if (!shaped || !TERMINAL_REJECTION_CODES.has(body.error.code)) return null;
    const expectedStatus = body.error.code === 'prompt_evidence_identity_conflict'
      ? 409
      : [
        'prompt_evidence_exceeds_limit',
        'prompt_evidence_request_too_large',
        'prompt_producer_evidence_exceeds_limit',
      ].includes(body.error.code)
        ? 413
        : body.error.code === 'prompt_evidence_unsupported_media_type'
          ? 415
          : 400;
    if (result.status !== expectedStatus) return null;
    return body.error.code;
  } catch {
    return null;
  }
}

function isTerminalInvalidHostPrompt(result) {
  return terminalRejectionCode(result) === 'invalid_host_prompt_id';
}

// ingest's AppError::PayloadTooLarge renders as this exact plain-text body,
// its one fixed 413 shape on these routes (apps/ingest/src/main.rs). An
// intermediary's own 413 — a misconfigured ingress, a CDN, or an old
// pre-contract server whose axum-default 413 body differs — must NOT match:
// classifying by status alone would permanently discard entries on a 413
// this client did not cause. Match the coded-400 path's strictness instead,
// so anything that isn't exactly this shape stays retryable (which also
// makes a misordered client/server deploy self-healing rather than a
// permanent loss).
const INGEST_PAYLOAD_TOO_LARGE_BODY = 'Request body too large';

function isTerminalHttp413(result) {
  return Boolean(result)
    && result.status === 413
    && result.mediaType === 'text/plain'
    && result.bodyTruncated !== true
    && result.body === INGEST_PAYLOAD_TOO_LARGE_BODY;
}

function responseFenceAllowsDelivery(entry) {
  if (!entry || entry.kind !== 'response' || entry.deliveryFence === undefined) {
    return { allowed: true, status: 'legacy' };
  }
  try {
    const { responseFenceStatus, recoverResponseFence } = require('./session');
    let status = responseFenceStatus(entry.deliveryFence);
    if (status === 'blocked_captured') status = recoverResponseFence(entry.deliveryFence);
    return {
      allowed: status === 'ready_consumed' || status === 'ready_invalidated' || status === 'ready_absent',
      status,
    };
  } catch {
    return { allowed: false, status: 'blocked_unreadable' };
  }
}

function listPending() {
  return pendingFiles()
    .map((file) => ({ entry: readEntry(file), file }))
    .filter(({ entry }) => entry)
    .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.file.localeCompare(b.file))
    .map(({ entry }) => entry);
}

function recordTerminalGap(id, reason, context = {}) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) return false;
  const entry = {
    id,
    kind: 'gap',
    payload: {
      schema_version: 1,
      reason: typeof reason === 'string' ? reason.slice(0, 128) : 'unknown',
      ...(context && typeof context === 'object' ? context : {}),
    },
    terminalReason: typeof reason === 'string' ? reason.slice(0, 128) : 'unknown',
    createdAt: new Date().toISOString(),
  };
  return settleTerminal(entry, true).state === 'terminal';
}

function markAcked(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  try {
    fs.unlinkSync(entryFile(id));
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'ENOENT');
  }
}

// Durably records one more failed delivery attempt so drain() can demote a
// repeatedly-failing entry behind fresher ones (see bySendPriority) instead
// of a single slow/unreachable entry blocking the whole spool forever on an
// oldest-first schedule. Best-effort and non-fatal: a lost bump only means
// the entry keeps its prior priority, never that delivery itself fails.
function bumpDeliveryAttempts(entry) {
  const file = entryFile(entry.id);
  // renameSync overwrites unconditionally (unlike every other publish path
  // here, which uses linkSync so it fails safely instead of clobbering), so
  // it can resurrect an entry a concurrent hook process already acked and
  // unlinked. Re-checking existence immediately before the rename narrows
  // that window; a race inside the remaining gap is still possible, but the
  // server's idempotent dedup absorbs the resulting resend — it is redundant
  // churn, not data loss.
  if (!fs.existsSync(file)) return;
  const attempts = Number.isSafeInteger(entry.deliveryAttempts) ? entry.deliveryAttempts : 0;
  const next = { ...entry, deliveryAttempts: attempts + 1 };
  if (!validEntry(next)) return;
  const serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ENTRY_BYTES) return;
  const dir = getOutboxDir();
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    if (!fs.existsSync(file)) return;
    fs.renameSync(temp, file);
  } catch {
    // fall through to cleanup
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function isSuccess(result) {
  return result && Number.isInteger(result.status) && result.status >= 200 && result.status < 300;
}

/**
 * Replay response intents ahead of unrelated prompts. A response whose pending
 * prompt dependency is not acknowledged in this pass stays queued.
 * @param {(entry: object, options: { deadline?: number }) => Promise<{status: number, body?: string}>} sender
 * @param {{ limit?: number, maxElapsedMs?: number, minRequestMs?: number, prioritizeIds?: string[] }} [options]
 * @returns {Promise<Array<{id: string, acked: boolean, result?: object}>>}
 */
async function drain(sender, options = {}) {
  pruneExpiredTerminalEntries();
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : Infinity;
  const maxElapsedMs = Number.isFinite(options.maxElapsedMs) && options.maxElapsedMs >= 0 ? options.maxElapsedMs : Infinity;
  const minRequestMs = Number.isFinite(options.minRequestMs) && options.minRequestMs >= 0 ? options.minRequestMs : 25;
  const deadline = maxElapsedMs === Infinity ? undefined : Date.now() + maxElapsedMs;
  if (deadline !== undefined && deadline - Date.now() < minRequestMs) return [];

  // Candidate order comes from a stat-only scan (filename + mtime, no JSON
  // parse) so a large spool never pays a full-parse cost just to decide what
  // to look at first. Entries are then parsed one at a time, oldest first,
  // bounded by the SAME deadline as delivery: under a tight deadline and a
  // large backlog, classification degrades to "consider what we had time to
  // read" instead of spending the whole hook budget parsing (potentially
  // multi-MB) entries before a single send is attempted.
  const candidates = pendingFilesWithStats();
  const parsedByFile = new Map();
  const parsedById = new Map();
  const parseFile = (file) => {
    if (parsedByFile.has(file)) return parsedByFile.get(file);
    const entry = readEntry(file);
    parsedByFile.set(file, entry);
    if (entry) parsedById.set(entry.id, entry);
    return entry;
  };
  const byId = (id) => (parsedById.has(id) ? parsedById.get(id) : parseFile(entryFile(id)));

  const prioritizeIds = new Set(Array.isArray(options.prioritizeIds) ? options.prioritizeIds : []);
  // Direct id-based lookups: prioritized entries (always the current hook's
  // own turn in practice) need not wait on the scan below, regardless of
  // spool size.
  for (const id of prioritizeIds) byId(id);

  const responses = [];
  const prompts = [];
  const evidence = [];
  for (const { file } of candidates) {
    if (deadline !== undefined && Date.now() > deadline) break;
    const entry = parseFile(file);
    if (!entry) continue;
    if (entry.kind === 'response') responses.push(entry);
    else if (entry.kind === 'prompt_evidence') evidence.push(entry);
    else prompts.push(entry);
  }

  const acknowledged = new Set();
  // Entries that failed a prior attempt are demoted behind fresher ones so
  // one persistently unreachable entry (a slow uplink, say) cannot occupy
  // every drain forever ahead of entries that would otherwise succeed
  // quickly. No backoff timer — just a stable reordering.
  const bySendPriority = (left, right) => (
    (Number.isSafeInteger(left.deliveryAttempts) ? left.deliveryAttempts : 0)
      - (Number.isSafeInteger(right.deliveryAttempts) ? right.deliveryAttempts : 0)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id)
  );
  const ordered = [];
  const scheduled = new Set();
  const schedule = (entry) => {
    if (entry && !scheduled.has(entry.id)) {
      scheduled.add(entry.id);
      ordered.push(entry);
    }
  };
  const scheduleResponse = (entry) => {
    if (entry.dependsOn) schedule(byId(entry.dependsOn));
    schedule(entry);
  };
  const prioritizedEntries = [...prioritizeIds].map(byId).filter(Boolean);
  for (const entry of prioritizedEntries.filter((entry) => entry.kind === 'response').sort(bySendPriority)) scheduleResponse(entry);
  for (const entry of responses.sort(bySendPriority)) scheduleResponse(entry);
  for (const entry of prioritizedEntries.filter((entry) => entry.kind === 'prompt').sort(bySendPriority)) schedule(entry);
  for (const entry of prompts.sort(bySendPriority)) schedule(entry);
  for (const entry of prioritizedEntries.filter((entry) => entry.kind === 'prompt_evidence').sort(bySendPriority)) schedule(entry);
  for (const entry of evidence.sort(bySendPriority)) schedule(entry);

  const outcomes = [];
  let attempts = 0;
  for (const entry of ordered) {
    if (attempts >= limit) break;
    const remainingMs = deadline === undefined ? Infinity : deadline - Date.now();
    if (remainingMs < minRequestMs) break;
    // byId re-reads the dependency fresh off disk (through the cache above)
    // rather than trusting a stale membership snapshot, and readEntry treats
    // an unparseable file the same as an absent one — a corrupt dependency
    // must not permanently block its response with no reaper to clear it.
    if (entry.dependsOn && (
      isTerminalRejected(entry.dependsOn)
      || (byId(entry.dependsOn) !== null && !acknowledged.has(entry.dependsOn))
    )) continue;
    const outcome = await deliverEntry(entry, sender, deadline);
    outcomes.push(outcome);
    if (!outcome.deferred) attempts += 1;
    if (outcome.acked) acknowledged.add(entry.id);
  }
  return outcomes;
}

/**
 * Replay only the durable prompt that can promote an exactly-correlated active
 * turn. It intentionally does not inspect or deliver unrelated backlog.
 * @param {{ sessionId: string, epoch: number, clientEventId: string, hostPromptId: string }} correlation
 * @param {(entry: object, options: { deadline?: number }) => Promise<{status: number, body?: string}>} sender
 * @param {{ maxElapsedMs?: number, minRequestMs?: number }} [options]
 * @returns {Promise<Array<{id: string, acked: boolean, result?: object}>>}
 */
async function replayPrompt(correlation, sender, options = {}) {
  pruneExpiredTerminalEntries();
  const maxElapsedMs = Number.isFinite(options.maxElapsedMs) && options.maxElapsedMs >= 0 ? options.maxElapsedMs : Infinity;
  const minRequestMs = Number.isFinite(options.minRequestMs) && options.minRequestMs >= 0 ? options.minRequestMs : 25;
  const deadline = maxElapsedMs === Infinity ? undefined : Date.now() + maxElapsedMs;
  if (
    !correlation
    || typeof correlation.sessionId !== 'string'
    || !Number.isSafeInteger(correlation.epoch)
    || typeof correlation.clientEventId !== 'string'
    || typeof correlation.hostPromptId !== 'string'
  ) return [];

  const matchesCorrelation = (candidate) => {
    const promotion = candidate && candidate.promotion;
    return candidate
      && candidate.kind === 'prompt'
      && promotion
      && promotion.sessionId === correlation.sessionId
      && promotion.epoch === correlation.epoch
      && promotion.clientEventId === correlation.clientEventId
      && promotion.hostPromptId === correlation.hostPromptId;
  };
  const directFile = entryFile(`prompt-${correlation.clientEventId}`);
  const directEntry = fs.existsSync(directFile) ? readEntry(directFile) : null;
  const entry = matchesCorrelation(directEntry)
    ? directEntry
    : listPending().find(matchesCorrelation);
  if (!entry || (deadline !== undefined && deadline - Date.now() < minRequestMs)) return [];
  return [await deliverEntry(entry, sender, deadline)];
}

async function deliverEntry(entry, sender, deadline) {
  try {
    const existingTerminal = settleTerminal(entry, false);
    if (existingTerminal.state === 'terminal') {
      return {
        id: entry.id,
        acked: false,
        terminal: true,
        terminalReason: existingTerminal.terminalReason || 'terminal_rejected',
        primaryRemoved: existingTerminal.primaryRemoved,
        result: undefined,
      };
    }
    if (existingTerminal.state !== 'absent') {
      debug(`ERROR terminal outbox ${existingTerminal.state}: id=${entry.id}`);
      return {
        id: entry.id,
        acked: false,
        terminal: false,
        terminalReason: `terminal_${existingTerminal.state}`,
        primaryRemoved: false,
      };
    }
    const fence = responseFenceAllowsDelivery(entry);
    if (!fence.allowed) {
      return {
        id: entry.id,
        acked: false,
        deferred: true,
        fenceStatus: fence.status,
      };
    }
    const result = await sender(entry, deadline === undefined ? {} : { deadline });
    const rejectionCode = terminalRejectionCode(result);
    const terminal413 = !rejectionCode && isTerminalHttp413(result);
    if (rejectionCode || terminal413) {
      const terminalReason = rejectionCode || 'http_413';
      const settled = settleTerminal({ ...entry, terminalReason }, true);
      return {
        id: entry.id,
        acked: false,
        terminal: settled.state === 'terminal',
        terminalReason: settled.state === 'terminal' ? terminalReason : `terminal_${settled.state}`,
        primaryRemoved: settled.primaryRemoved,
        result,
      };
    }
    const acked = isSuccess(result) && (!result || result.ack !== false) && markAcked(entry.id);
    if (!acked) bumpDeliveryAttempts(entry);
    return { id: entry.id, acked, result };
  } catch (err) {
    bumpDeliveryAttempts(entry);
    debug(`ERROR outbox drain: id=${entry.id} code=${(err && err.code) || 'unknown'}`);
    return { id: entry.id, acked: false };
  }
}

module.exports = {
  MAX_PENDING_ENTRIES,
  MAX_PENDING_BYTES,
  MAX_ENTRY_BYTES,
  MAX_TERMINAL_REJECTED_ENTRIES,
  MAX_TERMINAL_REJECTED_BYTES,
  TERMINAL_REJECTED_RETENTION_MS,
  MAX_TERMINAL_RESPONSE_BODY_BYTES,
  ORPHAN_TEMP_AGE_MS,
  getOutboxDir,
  getTerminalRejectedDir,
  enqueue,
  enqueueDetailed,
  serializedEntryBytes,
  listPending,
  markAcked,
  drain,
  replayPrompt,
  isTerminalInvalidHostPrompt,
  isTerminalHttp413,
  terminalRejectionCode,
  isTerminalRejected,
  recordTerminalGap,
  responseFenceAllowsDelivery,
};
