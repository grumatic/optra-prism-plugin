/**
 * Session state management.
 * Persists turn count and session start time to disk.
 *
 * Used by: hooks (stop-handler) and commands (status, cost).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { STATE_FILE } = require('./env');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

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

/**
 * Get the human-readable session name from Claude Code session metadata.
 * Scans ~/.claude/sessions/<pid>.json files for matching sessionId.
 *
 * @param {string} sessionId - The session_id from hook stdin
 * @returns {string|null} Session name or null if not found
 */
function getSessionName(sessionId) {
  if (!sessionId) return null;
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
        if (data.sessionId === sessionId) {
          return data.name || null;
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // sessions dir missing or unreadable
  }
  return null;
}

module.exports = { readState, writeState, getSessionName };
