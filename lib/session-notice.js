'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FLAG_PATTERN = /^[a-f0-9]{32}\.flag$/;

function noticeDirFor(dataDir) {
  return path.join(dataDir, 'runtime', 'notices');
}

function flagNameFor(sessionId, key) {
  return `${crypto.createHash('sha256').update(`${sessionId}\0${key}`).digest('hex').slice(0, 32)}.flag`;
}

function pruneExpiredFlags(dir, nowMs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !FLAG_PATTERN.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      if (nowMs - fs.statSync(file).mtimeMs > NOTICE_TTL_MS) fs.unlinkSync(file);
    } catch {}
  }
}

/**
 * Returns true only for the first claim of `key` within `sessionId`.
 * Fails open: an unusable data directory or session id still shows the notice.
 */
function claimSessionNotice({ dataDir, sessionId, key, now = Date.now } = {}) {
  if (typeof dataDir !== 'string'
    || dataDir.length === 0
    || dataDir.includes('\0')
    || !path.isAbsolute(dataDir)
    || typeof sessionId !== 'string'
    || sessionId.length === 0
    || typeof key !== 'string'
    || key.length === 0) {
    return true;
  }

  const dir = noticeDirFor(dataDir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return true;
  }
  try {
    fs.writeFileSync(path.join(dir, flagNameFor(sessionId, key)), '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    return !(error && error.code === 'EEXIST');
  }
  pruneExpiredFlags(dir, now());
  return true;
}

module.exports = {
  NOTICE_TTL_MS,
  claimSessionNotice,
  noticeDirFor,
};
