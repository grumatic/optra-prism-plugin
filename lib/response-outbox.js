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
const MAX_PENDING_BYTES = 128 * 1024 * 1024;
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
    && (entry.kind === 'prompt' || entry.kind === 'response')
    && entry.payload
    && typeof entry.payload === 'object'
    && !Array.isArray(entry.payload)
    && (entry.dependsOn === undefined || (typeof entry.dependsOn === 'string' && entry.dependsOn.length > 0 && entry.dependsOn.length <= 512))
    && typeof entry.createdAt === 'string'
    && Number.isFinite(Date.parse(entry.createdAt))
    && (entry.deliveryAttempts === undefined || (Number.isSafeInteger(entry.deliveryAttempts) && entry.deliveryAttempts >= 0))
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
  delete leftIntent.deliveryAttempts;
  delete rightIntent.deliveryAttempts;
  return stableJson(normalizedLeft) === stableJson(normalizedRight)
    || stableJson(leftIntent) === stableJson(rightIntent);
}

function reservePendingSlot(incomingBytes) {
  const files = pendingFilesWithStats();
  const incoming = Number.isSafeInteger(incomingBytes) && incomingBytes >= 0 ? incomingBytes : 0;
  let totalBytes = files.reduce((sum, f) => sum + f.size, 0) + incoming;
  const requiredCountEvictions = files.length - MAX_PENDING_ENTRIES + 1;
  const overByteBudget = () => totalBytes > MAX_PENDING_BYTES;
  if (requiredCountEvictions <= 0 && !overByteBudget()) return true;

  // Eviction order is the entry's own createdAt, not file mtime, so a repeatedly bumped (and thus mtime-refreshed) entry cannot dodge eviction by looking newest.
  const parsed = files
    .map(({ file, size }) => ({ file, size, entry: readEntry(file) }))
    .filter((candidate) => candidate.entry)
    .sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt) || a.file.localeCompare(b.file));

  // Responses are the sole durable record after Stop consumes a turn. We may
  // evict old prompt intents to make room, but never an unacknowledged response.
  let evicted = 0;
  for (const { file, size, entry } of parsed) {
    if (evicted >= requiredCountEvictions && !overByteBudget()) break;
    if (entry.kind !== 'prompt') continue;
    try {
      fs.unlinkSync(file);
      evicted += 1;
      totalBytes -= size;
      debug(`DROP outbox prompt beyond cap: ${path.basename(file)}`);
    } catch {}
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
 * @param {{ id: string, kind: 'prompt'|'response', payload: object, dependsOn?: string, createdAt?: string, promotion?: object, legacyPromotion?: object }} entry
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
    return { state: 'absent', primaryRemoved: false };
  }
  const serialized = JSON.stringify(entry);
  if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) {
    debug(`ERROR terminal outbox entry oversized: id=${entry.id}`);
    return { state: 'io_error', primaryRemoved: false };
  }
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  let lock;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireTerminalLock(dir);
    if (!lock) return { state: 'io_error', primaryRemoved: false };
    reapOrphanTemps(dir);
    pruneExpiredTerminalEntriesLocked();
    if (fs.existsSync(file)) {
      const existing = readTerminalEntry(file);
      if (!existing) return { state: 'corrupt', primaryRemoved: false };
      if (!sameEntry(existing, entry)) return { state: 'conflict', primaryRemoved: false };
    } else {
      if (!create) return { state: 'absent', primaryRemoved: false };
      if (!reserveTerminalSpace(Buffer.byteLength(serialized))) return { state: 'io_error', primaryRemoved: false };
      fs.writeFileSync(temp, serialized, { mode: 0o600 });
      try {
        fs.linkSync(temp, file);
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
      }
      const published = readTerminalEntry(file);
      if (!published) return { state: 'corrupt', primaryRemoved: false };
      if (!sameEntry(published, entry)) return { state: 'conflict', primaryRemoved: false };
    }
    return { state: 'terminal', primaryRemoved: markAcked(entry.id) };
  } catch (err) {
    debug(`ERROR terminal outbox write: ${(err && err.code) || 'unknown'}`);
    return { state: 'io_error', primaryRemoved: false };
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
]);

function terminalRejectionCode(result) {
  if (!result || result.status !== 400 || result.mediaType !== 'application/json') return null;
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
    return body.error.code;
  } catch {
    return null;
  }
}

function isTerminalInvalidHostPrompt(result) {
  return terminalRejectionCode(result) === 'invalid_host_prompt_id';
}

// Matched by exact body shape, not status alone: an intermediary's own unrelated 413 must stay retryable, not be discarded as terminal.
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

function markAcked(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  try {
    fs.unlinkSync(entryFile(id));
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'ENOENT');
  }
}

function bumpDeliveryAttempts(entry) {
  const file = entryFile(entry.id);
  // A race in the gap after this existence check is still possible; the server's idempotent dedup absorbs the resulting resend as redundant churn, not data loss.
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
  for (const id of prioritizeIds) byId(id);

  const responses = [];
  const others = [];
  for (const { file } of candidates) {
    if (deadline !== undefined && Date.now() > deadline) break;
    const entry = parseFile(file);
    if (!entry) continue;
    (entry.kind === 'response' ? responses : others).push(entry);
  }

  const acknowledged = new Set();
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
  for (const entry of prioritizedEntries.filter((entry) => entry.kind !== 'response').sort(bySendPriority)) schedule(entry);
  for (const entry of responses.sort(bySendPriority)) scheduleResponse(entry);
  for (const entry of others.sort(bySendPriority)) schedule(entry);

  const outcomes = [];
  let attempts = 0;
  for (const entry of ordered) {
    if (attempts >= limit) break;
    const remainingMs = deadline === undefined ? Infinity : deadline - Date.now();
    if (remainingMs < minRequestMs) break;
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
        terminalReason: 'invalid_host_prompt_id',
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
      const settled = settleTerminal(entry, true);
      return {
        id: entry.id,
        acked: false,
        terminal: settled.state === 'terminal',
        terminalReason: settled.state === 'terminal' ? (rejectionCode || 'http_413') : `terminal_${settled.state}`,
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
  responseFenceAllowsDelivery,
};
