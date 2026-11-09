'use strict';

/**
 * One debug.log line for each place git evidence is skipped, so a gap can be
 * traced afterwards. debug.log is never rotated and a service that takes no
 * evidence would otherwise add a line on every hook, so each reason is
 * written at most once an hour per session (per data directory when no
 * session is known). The last time per reason is kept next to the session's
 * own records. Never throws.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultPluginDataDir } = require('./claude-paths');
const { createDebug } = require('./debug');

const SKIP_LOG_INTERVAL_MS = 3600000;
const SKIP_LOG_FILE = 'git-evidence-skips.json';
const REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

let debug = null;

function runtimeDir() {
  return path.join(process.env.CLAUDE_PLUGIN_DATA || defaultPluginDataDir(), 'runtime');
}

function stateFile(sessionId) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const hashed = crypto.createHash('sha256').update(sessionId).digest('hex');
    return path.join(runtimeDir(), 'sessions', hashed, SKIP_LOG_FILE);
  }
  return path.join(runtimeDir(), SKIP_LOG_FILE);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function logEvidenceSkip(sessionId, reason, { now = Date.now() } = {}) {
  try {
    if (typeof reason !== 'string' || !REASON_PATTERN.test(reason)) return false;
    const file = stateFile(sessionId);
    const state = readState(file);
    const last = Date.parse(state[reason]);
    if (Number.isFinite(last) && now - last < SKIP_LOG_INTERVAL_MS) return false;

    if (!debug) debug = createDebug('git-evidence');
    const session = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId.slice(0, 8) : '-';
    debug(`skip reason=${reason} session=${session}`);

    state[reason] = new Date(now).toISOString();
    // A session directory is never created here: one with no turn record
    // would hold that session's stale responses back (blocked_missing).
    // Without it the line is logged and simply not rate-limited.
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      if (!fs.existsSync(path.dirname(file))) return true;
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    }
    const temp = path.join(path.dirname(file), `.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SKIP_LOG_INTERVAL_MS,
  SKIP_LOG_FILE,
  logEvidenceSkip,
};
