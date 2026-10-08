/**
 * Lockfile plus optimistic compare-and-swap update for one JSON file.
 *
 * Shared by the settings writer and the install inventory. The caller supplies
 * how to read a snapshot and how to compare two signatures, so this module
 * knows nothing about settings or inventory contents.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CAS_ATTEMPTS = 3;
const LOCK_WAIT_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function lockPathFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.prism.lock`);
}

function removeDeadLock(lockFile) {
  let stat;
  let record;
  try {
    stat = fs.lstatSync(lockFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return false;
  }
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return false;

  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    if (!error || error.code !== 'ESRCH') return false;
  }

  try {
    const current = fs.lstatSync(lockFile);
    if (current.dev !== stat.dev || current.ino !== stat.ino) return false;
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * `createDir: false` leaves a missing parent directory missing: opening the
 * lockfile then fails and the caller reports it, instead of creating the tree.
 */
function acquireLock(file, { createDir = true } = {}) {
  const lockFile = lockPathFor(file);
  if (createDir) fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const token = crypto.randomUUID();
    let descriptor;
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
      return { descriptor, lockFile, token };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeDeadLock(lockFile)) continue;
      if (attempt + 1 < CAS_ATTEMPTS) {
        Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, LOCK_WAIT_MS);
      }
    }
  }
  return null;
}

function releaseLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.descriptor); } catch {}
  try {
    const record = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
    if (record && record.token === lock.token) fs.unlinkSync(lock.lockFile);
  } catch {}
}

function writeJsonAtomicCas(file, data, expectedSignature, {
  readSnapshot,
  signaturesMatch,
  createDir = true,
  writeMode,
}) {
  const mode = writeMode === undefined ? expectedSignature.mode : writeMode;
  const dir = path.dirname(file);
  if (createDir) fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, {
      mode,
      flag: 'wx',
    });

    let current;
    try {
      current = readSnapshot(file);
    } catch {
      return false;
    }
    if (!signaturesMatch(current.signature, expectedSignature)) return false;

    fs.renameSync(tempFile, file);
    fs.chmodSync(file, mode);
    return true;
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

/**
 * Locks `file`, then repeatedly: read a snapshot, ask `project(snapshot.value)`
 * for a proposal, and write `selectData(proposal)` only if the file still
 * matches the snapshot's signature. A proposal without `changed` writes nothing.
 *
 * `readSnapshot(file)` returns `{ value, signature }` and throws when the file
 * cannot be read safely; `signature.mode` is the file mode to write with.
 * `writeMode`, when given, is the mode every successful write leaves the file
 * with, instead of the mode it had. `noun` only labels failure reasons.
 */
function updateJsonAtomic(file, {
  project,
  readSnapshot,
  signaturesMatch,
  selectData = (proposal) => proposal.data,
  noun = 'file',
  createDir = true,
  writeMode,
}) {
  let lock;
  try {
    lock = acquireLock(file, { createDir });
  } catch (error) {
    return { ok: false, changed: false, reason: `unable to lock ${noun}: ${error.message}` };
  }
  if (!lock) return { ok: false, changed: false, reason: `${noun} update is locked` };

  try {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      let snapshot;
      try {
        snapshot = readSnapshot(file);
      } catch (error) {
        return {
          ok: false,
          reason: `unable to read ${noun} safely: ${error.message}`,
        };
      }

      const proposal = project(snapshot.value);
      if (!proposal.changed) return { ok: true, ...proposal };
      if (writeJsonAtomicCas(file, selectData(proposal), snapshot.signature, {
        readSnapshot,
        signaturesMatch,
        createDir,
        writeMode,
      })) {
        return { ok: true, ...proposal };
      }
    }

    return {
      ok: false,
      changed: false,
      reason: `${noun} changed concurrently`,
    };
  } finally {
    releaseLock(lock);
  }
}

module.exports = {
  CAS_ATTEMPTS,
  updateJsonAtomic,
};
