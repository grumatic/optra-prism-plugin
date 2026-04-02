/**
 * Session state management.
 * Persists turn count and session start time to disk.
 *
 * Used by: hooks (stop-handler) and commands (status, cost).
 */

const fs = require('fs');
const path = require('path');
const { STATE_FILE } = require('./env');

function readState() {
  if (!STATE_FILE) return { turnCount: 0, sessionStart: Date.now() };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { turnCount: 0, sessionStart: Date.now() };
  }
}

function writeState(state) {
  if (!STATE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // Non-critical — don't block on state persistence failure
  }
}

module.exports = { readState, writeState };
