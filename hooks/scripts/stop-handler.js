#!/usr/bin/env node
/**
 * ─── Stop Hook ───
 *
 * Runs when Claude stops. Two responsibilities:
 * 1. Capture: send response to ingest service
 * 2. Advise: nudge user when context is getting bloated
 *
 * Input (stdin JSON from Claude Code):
 *   { session_id, last_assistant_message, stop_hook_active, cwd, hook_event_name, ... }
 *
 * Output:
 *   exit 0 — allow Claude to stop
 */

const { createDebug } = require('../../lib/debug');
const { GCK_KEY } = require('../../lib/env');
const { readStdin } = require('../../lib/stdin');
const { sendResponse } = require('../../lib/ingest');
const { readState, writeState } = require('../../lib/session');

const debug = createDebug('stop-handler');

readStdin().then(async (data) => {
  debug(`HOOK FIRED session_id=${data.session_id || '(none)'} gck=${GCK_KEY ? 'set' : 'missing'}`);

  const state = readState();

  // Update turn counter
  state.turnCount = (state.turnCount || 0) + 1;
  writeState(state);

  // ─── Context bloat nudge ───
  if (state.turnCount > 0 && state.turnCount % 10 === 0) {
    process.stderr.write(
      `[Prism] ${state.turnCount} turns in this session. Consider /compact to free context.\n`
    );
  }

  debug(`turn=${state.turnCount}`);

  // ─── Capture response to ingest service ───
  if (!GCK_KEY) {
    debug('SKIP ingest: no API key');
    process.exit(0);
  }

  try {
    await sendResponse({
      tool_session_id: data.session_id,
      response_text: (data.last_assistant_message || '').slice(0, 2000),
    });
  } catch (err) {
    debug(`INGEST ERROR: ${err.message || err}`);
  }

  process.exit(0);
}).catch((err) => {
  debug(`FATAL: ${err.message || err}`);
  process.exit(0);
});
