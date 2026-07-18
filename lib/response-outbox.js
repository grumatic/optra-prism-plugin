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
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const ORPHAN_TEMP_AGE_MS = 5 * 60 * 1000;
const debug = createDebug('response-outbox');

function getOutboxDir() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'prism-optra-prism');
  return path.join(dataDir, 'runtime', 'outbox');
}

function entryFile(id) {
  return path.join(getOutboxDir(), `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
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
    ));
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

function sameEntry(left, right) {
  const normalizedLeft = canonicalEntry(left);
  const normalizedRight = canonicalEntry(right);
  if (!validEntry(normalizedLeft) || !validEntry(normalizedRight)) return false;
  const leftIntent = { ...normalizedLeft };
  const rightIntent = { ...normalizedRight };
  delete leftIntent.createdAt;
  delete rightIntent.createdAt;
  return stableJson(normalizedLeft) === stableJson(normalizedRight)
    || stableJson(leftIntent) === stableJson(rightIntent);
}

function reservePendingSlot() {
  const files = pendingFiles().map((file) => {
    const entry = readEntry(file);
    return { file, entry, createdAtMs: entry ? Date.parse(entry.createdAt) : 0 };
  }).sort((a, b) => a.createdAtMs - b.createdAtMs || a.file.localeCompare(b.file));
  const requiredEvictions = files.length - MAX_PENDING_ENTRIES + 1;
  if (requiredEvictions <= 0) return true;

  // Responses are the sole durable record after Stop consumes a turn. We may
  // evict old prompt intents to make room, but never an unacknowledged response.
  let evicted = 0;
  for (const { file, entry } of files) {
    if (evicted >= requiredEvictions) break;
    if (!entry || entry.kind !== 'prompt') continue;
    try {
      fs.unlinkSync(file);
      evicted += 1;
      debug(`DROP outbox prompt beyond cap: ${path.basename(file)}`);
    } catch {}
  }
  if (evicted === requiredEvictions) return true;

  // A caller that cannot durably queue a response must leave its turn
  // unconsumed; dropping an existing response would permanently lose it.
  debug('ERROR outbox full: preserving unacknowledged response intents');
  return false;
}

/**
 * Publish a send intent without replacing an already published intent with the
 * same deterministic id.
 * @param {{ id: string, kind: 'prompt'|'response', payload: object, dependsOn?: string, createdAt?: string, promotion?: { sessionId: string, epoch: number, clientEventId: string, hostPromptId: string } }} entry
 * @returns {boolean}
 */
function enqueue(entry) {
  const normalized = { ...entry, createdAt: entry && entry.createdAt ? entry.createdAt : new Date().toISOString() };
  if (!validEntry(normalized)) {
    debug('SKIP invalid outbox enqueue');
    return false;
  }

  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized) > MAX_ENTRY_BYTES) {
    debug(`SKIP oversized outbox entry: id=${normalized.id}`);
    return false;
  }

  const dir = getOutboxDir();
  const file = entryFile(normalized.id);
  const temp = path.join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    reapOrphanTemps(dir);
    if (!fs.existsSync(file) && !reservePendingSlot()) return false;
    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      const existing = readEntry(file);
      if (sameEntry(existing, normalized)) {
        // The existing final is already this exact durable publication.
      } else if (existing) {
        debug(`ERROR outbox enqueue: conflicting final id=${normalized.id}`);
        return false;
      } else {
        const quarantine = path.join(dir, `.${path.basename(file)}.${crypto.randomUUID()}.corrupt`);
        fs.renameSync(file, quarantine);
        fs.linkSync(temp, file);
      }
    }
    const published = readEntry(file);
    if (!sameEntry(published, normalized)) {
      debug(`ERROR outbox enqueue: final validation failed id=${normalized.id}`);
      return false;
    }
    return true;
  } catch (err) {
    debug(`ERROR outbox enqueue: ${(err && err.code) || 'unknown'}`);
    return false;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
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
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : Infinity;
  const maxElapsedMs = Number.isFinite(options.maxElapsedMs) && options.maxElapsedMs >= 0 ? options.maxElapsedMs : Infinity;
  const minRequestMs = Number.isFinite(options.minRequestMs) && options.minRequestMs >= 0 ? options.minRequestMs : 25;
  const deadline = maxElapsedMs === Infinity ? undefined : Date.now() + maxElapsedMs;
  const pending = listPending();
  if (deadline !== undefined && deadline - Date.now() < minRequestMs) return [];
  const pendingIds = new Set(pending.map((entry) => entry.id));
  const entriesById = new Map(pending.map((entry) => [entry.id, entry]));
  const acknowledged = new Set();
  const prioritizeIds = new Set(Array.isArray(options.prioritizeIds) ? options.prioritizeIds : []);
  const byAge = (left, right) => (
    left.createdAt.localeCompare(right.createdAt)
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
    if (entry.dependsOn) schedule(entriesById.get(entry.dependsOn));
    schedule(entry);
  };
  const prioritized = pending.filter((entry) => prioritizeIds.has(entry.id)).sort(byAge);
  for (const entry of prioritized.filter((entry) => entry.kind === 'response')) scheduleResponse(entry);
  for (const entry of prioritized.filter((entry) => entry.kind !== 'response')) schedule(entry);
  for (const entry of pending.filter((entry) => entry.kind === 'response').sort(byAge)) scheduleResponse(entry);
  for (const entry of pending.filter((entry) => entry.kind !== 'response').sort(byAge)) schedule(entry);

  const outcomes = [];
  let attempts = 0;
  for (const entry of ordered) {
    if (attempts >= limit) break;
    const remainingMs = deadline === undefined ? Infinity : deadline - Date.now();
    if (remainingMs < minRequestMs) break;
    if (entry.dependsOn && pendingIds.has(entry.dependsOn) && !acknowledged.has(entry.dependsOn)) continue;
    outcomes.push(await deliverEntry(entry, sender, deadline));
    attempts += 1;
    if (outcomes.at(-1).acked) acknowledged.add(entry.id);
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
    const result = await sender(entry, deadline === undefined ? {} : { deadline });
    const acked = isSuccess(result) && (!result || result.ack !== false) && markAcked(entry.id);
    return { id: entry.id, acked, result };
  } catch (err) {
    debug(`ERROR outbox drain: id=${entry.id} code=${(err && err.code) || 'unknown'}`);
    return { id: entry.id, acked: false };
  }
}

module.exports = {
  MAX_PENDING_ENTRIES,
  MAX_ENTRY_BYTES,
  ORPHAN_TEMP_AGE_MS,
  getOutboxDir,
  enqueue,
  listPending,
  markAcked,
  drain,
  replayPrompt,
};
