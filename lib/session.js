/**
 * Session state management.
 *
 * The legacy state adapter remains for stop-handler compatibility. New hook
 * coordination is isolated by a stable hash of the Claude session identity.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;
const LOCK_TIMEOUT_MS = 200;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 30_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLEANUP_DIRECTORIES = 100;
const ACTIVE_STATUSES = new Set(['submitting', 'captured', 'consumed', 'invalidated']);
const TURN_KINDS = new Set(['control', 'normal-pending', 'failed', 'lifecycle']);
const READ_RECORD_RETRIES = 5;
const RETAINED_FENCE_FILES = 4;
const testHooks = {
  afterReadRecordEntries: null,
  beforeReleaseUnlink: null,
};

function getRuntimeSessionsDir() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.prism');
  return path.join(dataDir, 'runtime', 'sessions');
}

function getSessionDir(sessionId) {
  return path.join(getRuntimeSessionsDir(), crypto.createHash('sha256').update(sessionId).digest('hex'));
}

function validSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 1024;
}

function now() {
  return new Date().toISOString();
}

function timestampIsValid(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function defaultTurn(sessionId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    updatedAt: now(),
    generation: 0,
    epoch: 0,
    kind: 'lifecycle',
    active: null,
  };
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

function isActiveRecord(value) {
  return value === null || (
    value
    && typeof value === 'object'
    && hasOnlyKeys(value, new Set([
      'clientEventId',
      'submitPromptId',
      'submittedAt',
      'transcriptBoundary',
      'frozenPayloadHash',
      'status',
    ]))
    && hasOnlyKeys(value.transcriptBoundary || {}, new Set(['byteOffset', 'lineOffset']))
    && typeof value.clientEventId === 'string'
    && value.clientEventId.length > 0
    && (value.submitPromptId === undefined || typeof value.submitPromptId === 'string')
    && timestampIsValid(value.submittedAt)
    && value.transcriptBoundary
    && Number.isInteger(value.transcriptBoundary.byteOffset)
    && value.transcriptBoundary.byteOffset >= 0
    && Number.isInteger(value.transcriptBoundary.lineOffset)
    && value.transcriptBoundary.lineOffset >= 0
    && typeof value.frozenPayloadHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.frozenPayloadHash)
    && ACTIVE_STATUSES.has(value.status)
  );
}

function isTurnRecord(value, sessionId) {
  return value
    && typeof value === 'object'
    && hasOnlyKeys(value, new Set([
      'schemaVersion',
      'sessionId',
      'updatedAt',
      'generation',
      'epoch',
      'kind',
      'active',
    ]))
    && value.schemaVersion === SCHEMA_VERSION
    && value.sessionId === sessionId
    && timestampIsValid(value.updatedAt)
    && Number.isInteger(value.generation)
    && value.generation >= 0
    && Number.isInteger(value.epoch)
    && value.epoch >= 0
    && TURN_KINDS.has(value.kind)
    && isActiveRecord(value.active);
}

function isCompactRecord(value, sessionId) {
  return value
    && typeof value === 'object'
    && hasOnlyKeys(value, new Set(['schemaVersion', 'sessionId', 'updatedAt', 'generation']))
    && value.schemaVersion === SCHEMA_VERSION
    && value.sessionId === sessionId
    && timestampIsValid(value.updatedAt)
    && Number.isInteger(value.generation)
    && value.generation >= 0;
}

function isSummaryRecord(value, sessionId) {
  return isCompactRecord(value, sessionId);
}

function readJsonResult(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, value: null };
  }
}

function recordFileName(name, generation, fence) {
  return `${name}.g${generation}.f${fence}.json`;
}

function recordFileInfo(name, fileName) {
  const match = new RegExp(`^${name}\\.g(\\d+)\\.f(\\d+)\\.json$`).exec(fileName)
    || new RegExp(`^${name}\\.g(\\d+)\\.json$`).exec(fileName);
  if (!match) return null;

  const generation = Number(match[1]);
  const fence = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(fence) || fence < 0) return null;
  return { generation, fence };
}

function compareRecordOrder(left, right) {
  return left.fence - right.fence || left.generation - right.generation;
}

function readRecordEntry(sessionId, name, validator) {
  if (!validSessionId(sessionId)) return null;

  const dir = getSessionDir(sessionId);
  let previousEmptySnapshot = null;
  for (let attempt = 0; attempt < READ_RECORD_RETRIES; attempt += 1) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const snapshot = entries.map((entry) => entry.name).sort().join('\n');

    const hook = testHooks.afterReadRecordEntries;
    if (hook) hook({ sessionId, name, dir, entries });

    let latest = null;
    let readFailed = false;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const info = recordFileInfo(name, entry.name);
      if (!info) continue;

      const result = readJsonResult(path.join(dir, entry.name));
      if (!result.ok) {
        readFailed = true;
        continue;
      }
      const { value } = result;
      if (
        value
        && value.generation === info.generation
        && validator(value, sessionId)
        && (!latest || compareRecordOrder(info, latest) > 0)
      ) latest = { ...info, value };
    }
    if (latest) return latest;
    if (readFailed) {
      previousEmptySnapshot = null;
      continue;
    }
    if (snapshot === previousEmptySnapshot) return null;
    previousEmptySnapshot = snapshot;
  }
  return null;
}

function readRecord(sessionId, name, validator) {
  const record = readRecordEntry(sessionId, name, validator);
  return record ? record.value : null;
}

function highestFence(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  let highest = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^fence\.f(\d+)\.json$/.exec(entry.name);
    if (!match) continue;
    const fence = Number(match[1]);
    if (Number.isSafeInteger(fence) && fence > highest) highest = fence;
  }
  return highest;
}

function allocateFence(dir) {
  let fence = highestFence(dir);
  if (fence === null) return null;
  fence += 1;

  while (Number.isSafeInteger(fence)) {
    const temp = path.join(dir, `.fence.${process.pid}.${crypto.randomUUID()}.tmp`);
    const file = path.join(dir, `fence.f${fence}.json`);
    try {
      fs.writeFileSync(temp, JSON.stringify({ fence }), { mode: 0o600 });
      fs.linkSync(temp, file);
      return fence;
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      fence += 1;
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {}
    }
  }
  return null;
}

function pruneFenceFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const fences = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^fence\.f(\d+)\.json$/.exec(entry.name);
    if (!match) continue;
    const fence = Number(match[1]);
    if (Number.isSafeInteger(fence)) fences.push({ fence, file: path.join(dir, entry.name) });
  }

  fences.sort((left, right) => right.fence - left.fence);
  for (const entry of fences.slice(RETAINED_FENCE_FILES)) {
    try {
      fs.unlinkSync(entry.file);
    } catch {}
  }
}

function pruneRecordGenerations(dir, name, validator, sessionId) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const info = recordFileInfo(name, entry.name);
    if (!info) continue;

    const file = path.join(dir, entry.name);
    const { value } = readJsonResult(file);
    if (value && value.generation === info.generation && validator(value, sessionId)) {
      records.push({ file, ...info });
    }
  }

  records.sort((left, right) => compareRecordOrder(right, left));
  for (const record of records.slice(2)) {
    try {
      fs.unlinkSync(record.file);
    } catch {}
  }
  pruneFenceFiles(dir);
}

function writeRecord(dir, name, value, expectedGeneration, validator, sessionId, fence) {
  const current = readRecord(sessionId, name, validator);
  const currentGeneration = current ? current.generation : null;
  if (
    !Number.isSafeInteger(fence)
    || fence <= 0
    || currentGeneration !== expectedGeneration
    || !validator(value, sessionId)
    || value.generation !== (expectedGeneration === null ? 1 : expectedGeneration + 1)
  ) return false;

  const temp = path.join(dir, `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const file = path.join(dir, recordFileName(name, value.generation, fence));
  let published = false;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.linkSync(temp, file);
    published = true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }

  if (published) pruneRecordGenerations(dir, name, validator, sessionId);
  return published;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function releaseLock(lockDir, token) {
  const tokenFile = path.join(lockDir, 'token');
  try {
    const original = fs.statSync(tokenFile);
    if (fs.readFileSync(tokenFile, 'utf8') !== token) return;
    const current = fs.statSync(tokenFile);
    if (current.dev !== original.dev || current.ino !== original.ino) return;
    // A takeover between this check and unlink can delete its lock, but its higher
    // fence still orders every subsequent record ahead of this owner.
    const hook = testHooks.beforeReleaseUnlink;
    if (hook) hook({ lockDir, tokenFile, token });
    fs.unlinkSync(tokenFile);
    fs.rmdirSync(lockDir);
  } catch {}
}

function reclaimStaleLock(lockDir) {
  try {
    if (Date.now() - fs.statSync(lockDir).mtimeMs <= STALE_LOCK_MS) return false;
    const quarantine = `${lockDir}.stale.${process.pid}.${crypto.randomUUID()}`;
    fs.renameSync(lockDir, quarantine);
    fs.rmSync(quarantine, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function withSessionDirectoryLock(sessionDir, operation, createSessionDir = true, assignFence = true) {
  const lockDir = `${sessionDir}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') return null;
      reclaimStaleLock(lockDir);
      sleep(LOCK_RETRY_MS);
      continue;
    }

    const token = crypto.randomUUID();
    try {
      fs.writeFileSync(path.join(lockDir, 'token'), token, { mode: 0o600, flag: 'wx' });
    } catch {
      try {
        fs.rmdirSync(lockDir);
      } catch {}
      return null;
    }

    try {
      if (createSessionDir) fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const fence = assignFence ? allocateFence(sessionDir) : null;
      if (assignFence && fence === null) return null;
      try {
        return operation(sessionDir, fence);
      } finally {
        // Bound fence markers even when the callback publishes nothing
        // (stale/invalid attach, promote, fail, or no-op callers); the
        // highest markers are retained so allocation stays monotonic.
        if (assignFence) {
          try {
            pruneFenceFiles(sessionDir);
          } catch {}
        }
      }
    } catch {
      return null;
    } finally {
      releaseLock(lockDir, token);
    }
  }
  return null;
}

function withSessionLock(sessionId, operation) {
  if (!validSessionId(sessionId)) return null;

  try {
    fs.mkdirSync(getRuntimeSessionsDir(), { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return withSessionDirectoryLock(getSessionDir(sessionId), operation);
}

function summaryRecord(sessionId, generation) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    updatedAt: now(),
    generation,
  };
}

function ensureSummary(sessionId, sessionDir, fence) {
  const summary = readRecord(sessionId, 'summary', isSummaryRecord);
  if (summary) return true;
  return writeRecord(sessionDir, 'summary', summaryRecord(sessionId, 1), null, isSummaryRecord, sessionId, fence);
}

/**
 * Advance a session barrier. Any active submission from the preceding epoch is
 * retained only as an invalidated record, never as a valid correlation target.
 */
function advanceBarrier(sessionId, kind) {
  if (!TURN_KINDS.has(kind)) return null;
  return withSessionLock(sessionId, (sessionDir, fence) => {
    if (!ensureSummary(sessionId, sessionDir, fence)) return null;
    const currentRecord = readRecord(sessionId, 'turn', isTurnRecord);
    const current = currentRecord || defaultTurn(sessionId);
    const next = {
      ...current,
      updatedAt: now(),
      generation: current.generation + 1,
      epoch: current.epoch + 1,
      kind,
      active: current.active ? { ...current.active, status: 'invalidated' } : null,
    };
    return writeRecord(
      sessionDir,
      'turn',
      next,
      currentRecord ? current.generation : null,
      isTurnRecord,
      sessionId,
      fence,
    ) ? next : null;
  });
}

function attachActive(sessionId, activeRecord) {
  return withSessionLock(sessionId, (sessionDir, fence) => {
    const current = readRecord(sessionId, 'turn', isTurnRecord);
    if (!current || current.kind !== 'normal-pending') return null;
    if (activeRecord && activeRecord.epoch !== undefined && activeRecord.epoch !== current.epoch) return null;

    const active = {
      clientEventId: activeRecord && activeRecord.clientEventId,
      submittedAt: activeRecord && activeRecord.submittedAt,
      transcriptBoundary: activeRecord && activeRecord.transcriptBoundary,
      frozenPayloadHash: activeRecord && activeRecord.frozenPayloadHash,
      status: activeRecord && activeRecord.status,
    };
    if (activeRecord && activeRecord.submitPromptId !== undefined) active.submitPromptId = activeRecord.submitPromptId;
    if (!isActiveRecord(active) || active.status !== 'submitting') return null;

    const next = {
      ...current,
      updatedAt: now(),
      generation: current.generation + 1,
      active,
    };
    return writeRecord(sessionDir, 'turn', next, current.generation, isTurnRecord, sessionId, fence) ? next : null;
  });
}

function promoteActive(sessionId, clientEventId, serverPromptId) {
  if (!clientEventId || serverPromptId === null || serverPromptId === undefined || serverPromptId === '') return null;
  return withSessionLock(sessionId, (sessionDir, fence) => {
    const current = readRecord(sessionId, 'turn', isTurnRecord);
    if (!current || !current.active || current.active.clientEventId !== clientEventId || current.active.status !== 'submitting') return null;
    const next = {
      ...current,
      updatedAt: now(),
      generation: current.generation + 1,
      active: { ...current.active, submitPromptId: String(serverPromptId), status: 'captured' },
    };
    return writeRecord(sessionDir, 'turn', next, current.generation, isTurnRecord, sessionId, fence) ? next : null;
  });
}

function failBarrier(sessionId, expectedEpoch) {
  return withSessionLock(sessionId, (sessionDir, fence) => {
    const current = readRecord(sessionId, 'turn', isTurnRecord);
    if (!current || (expectedEpoch !== undefined && current.epoch !== expectedEpoch)) return null;
    const next = {
      ...current,
      updatedAt: now(),
      generation: current.generation + 1,
      kind: 'failed',
      active: null,
    };
    return writeRecord(sessionDir, 'turn', next, current.generation, isTurnRecord, sessionId, fence) ? next : null;
  });
}

function readTurn(sessionId) {
  return readRecord(sessionId, 'turn', isTurnRecord) || (validSessionId(sessionId) ? defaultTurn(sessionId) : null);
}

function advanceCompactGeneration(sessionId) {
  return withSessionLock(sessionId, (sessionDir, fence) => {
    if (!ensureSummary(sessionId, sessionDir, fence)) return null;
    const current = readRecord(sessionId, 'compact', isCompactRecord);
    const generation = (current ? current.generation : 0) + 1;
    const next = summaryRecord(sessionId, generation);
    return writeRecord(sessionDir, 'compact', next, current ? current.generation : null, isCompactRecord, sessionId, fence) ? next : null;
  });
}

function advanceCompactBarrier(sessionId) {
  return withSessionLock(sessionId, (sessionDir, fence) => {
    if (!ensureSummary(sessionId, sessionDir, fence)) return null;

    const currentTurnRecord = readRecord(sessionId, 'turn', isTurnRecord);
    const currentTurn = currentTurnRecord || defaultTurn(sessionId);
    const nextTurn = {
      ...currentTurn,
      updatedAt: now(),
      generation: currentTurn.generation + 1,
      epoch: currentTurn.epoch + 1,
      kind: 'lifecycle',
      active: currentTurn.active ? { ...currentTurn.active, status: 'invalidated' } : null,
    };
    const currentCompact = readRecord(sessionId, 'compact', isCompactRecord);
    const nextCompact = summaryRecord(sessionId, (currentCompact ? currentCompact.generation : 0) + 1);

    if (!writeRecord(
      sessionDir,
      'turn',
      nextTurn,
      currentTurnRecord ? currentTurn.generation : null,
      isTurnRecord,
      sessionId,
      fence,
    )) return null;
    if (!writeRecord(
      sessionDir,
      'compact',
      nextCompact,
      currentCompact ? currentCompact.generation : null,
      isCompactRecord,
      sessionId,
      fence,
    )) return null;
    return { barrier: nextTurn, compact: nextCompact };
  });
}

function cleanupStaleSessions() {
  const sessionsDir = getRuntimeSessionsDir();
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => {
        const entryPath = path.join(sessionsDir, entry.name);
        try {
          return { path: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .slice(0, MAX_CLEANUP_DIRECTORIES);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - SESSION_TTL_MS;
  let removed = 0;
  for (const entry of entries) {
    if (entry.mtimeMs >= cutoff) continue;
    if (withSessionDirectoryLock(entry.path, () => {
      try {
        if (fs.statSync(entry.path).mtimeMs >= cutoff) return false;
        fs.rmSync(entry.path, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }, false, false)) removed += 1;
  }
  return removed;
}

/** @deprecated Legacy singleton adapter retained for stop-handler compatibility. */
function readState() {
  const stateFile = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'session-state.json')
    : path.join(os.homedir(), '.prism', 'session-state.json');
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { turnCount: 0, sessionStart: Date.now() };
  }
}

/** @deprecated Legacy singleton adapter retained for stop-handler compatibility. */
function writeState(state) {
  const stateFile = process.env.CLAUDE_PLUGIN_DATA
    ? path.join(process.env.CLAUDE_PLUGIN_DATA, 'session-state.json')
    : path.join(os.homedir(), '.prism', 'session-state.json');
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {
    // Non-critical — don't block on state persistence failure.
  }
}

/**
 * Get the human-readable session name from Claude Code session metadata.
 * Scans ~/.claude/sessions/<pid>.json files for matching sessionId.
 */
function getSessionName(sessionId) {
  if (!sessionId) return null;
  try {
    const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
        if (data.sessionId === sessionId) return data.name || null;
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = {
  advanceBarrier,
  attachActive,
  promoteActive,
  failBarrier,
  readTurn,
  advanceCompactGeneration,
  advanceCompactBarrier,
  cleanupStaleSessions,
  readState,
  writeState,
  withSessionLock,
  getSessionName,
  _internals: {
    allocateFence,
    setTestHook(name, hook) {
      if (!Object.hasOwn(testHooks, name)) throw new Error(`Unknown test hook: ${name}`);
      testHooks[name] = hook;
    },
  },
};
