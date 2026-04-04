#!/usr/bin/env node
/**
 * --- UserPromptSubmit Hook ---
 *
 * Lightweight, non-blocking prompt handler:
 * 1. Displays the status line from the previous turn (saved by stop handler).
 * 2. Context nudges (/compact, /clear) based on session metrics.
 * 3. Records prompt timestamp for response-time measurement.
 * 4. Captures prompt to ingest service.
 *
 * Prompt quality evaluation is handled by the prism-advisor skill
 * (always-active, user-invocable: false). The advisor's output is
 * captured by the stop handler from last_assistant_message.
 *
 * Input (stdin JSON from Claude Code):
 *   { session_id, prompt, cwd, hook_event_name, transcript_path, permission_mode }
 *
 * Output:
 *   exit 0 --- always allows prompt through (never blocks)
 *   stderr  --- status line from previous turn, context nudges
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { GCK_KEY, INGEST_URL } = require('../../lib/env');
const { createDebug } = require('../../lib/debug');
const { readStdin } = require('../../lib/stdin');
const { sendPrompt } = require('../../lib/ingest');
const { readState, writeState, getSessionName } = require('../../lib/session');

const ADVISOR_CONTEXT_FILE = path.join(os.homedir(), '.prism', 'advisor-context.json');

const debug = createDebug('submit-handler');

// Short prompts that are navigational / meta --- skip processing
const SKIP_PATTERNS = [
  /^\//, // slash commands
  /^(y|n|yes|no|ok|done|thanks|exit|quit|help|continue|go ahead|looks good|lgtm|approve)$/i,
  /^\!/, // shell passthrough
];

readStdin().then(async (data) => {
  const prompt = (data.prompt || '').trim();

  debug(`HOOK FIRED session_id=${data.session_id || '(none)'} prompt_length=${prompt.length} gck=${GCK_KEY ? 'set' : 'missing'}`);

  // Let /prism: commands through
  if (prompt.startsWith('/prism:')) {
    debug('allowing /prism: command through');
    process.exit(0);
  }

  // If no key, warn but allow prompt through
  if (!GCK_KEY || !INGEST_URL) {
    debug('WARN: no API key or ingest URL --- allowing prompt through');
    process.stderr.write('[Prism] API key not configured. Run /prism:setup to set your gck_* key.\n');
    process.exit(0);
  }

  // --- Display status line from previous turn (saved by stop handler) ---
  debug('emitting pending status line...');
  emitPendingStatusLine();

  // Skip processing for short navigational prompts
  const shouldSkip = prompt.length < 10 || SKIP_PATTERNS.some((p) => p.test(prompt));
  if (shouldSkip) {
    debug('SKIP: prompt too short or navigational');
    recordAndCapture(data, prompt);
    return;
  }

  const state = readState();

  // --- Update advisor context for the skill ---
  writeAdvisorContext(data, state);

  // --- Context management nudges ---
  const nudge = buildContextNudge(state);
  if (nudge) {
    debug(`context nudge: ${nudge.replace(/\x1b\[[0-9;]*m/g, '')}`);
    process.stderr.write(nudge + '\n');
  }

  recordAndCapture(data, prompt);

}).catch((err) => {
  debug(`FATAL: ${err.message || err}\n${err.stack || ''}`);
  process.exit(0); // fail open
});

// --- Emit pending status line + alerts from stop handler ---

function emitPendingStatusLine() {
  try {
    const state = readState();
    debug(`pending state: statusLine=${state.pendingStatusLine ? 'yes' : 'no'} alerts=${state.pendingAlerts ? state.pendingAlerts.length : 0}`);
    const lines = [];

    if (state.pendingStatusLine) {
      lines.push(state.pendingStatusLine);
    }
    if (state.pendingAlerts && state.pendingAlerts.length > 0) {
      lines.push(...state.pendingAlerts);
    }

    if (lines.length > 0) {
      debug(`writing ${lines.length} line(s) to stderr`);
      process.stderr.write(lines.join('\n') + '\n');
      debug('emitted pending status line');
    } else {
      debug('no pending status line to emit');
    }

    // Clear pending output so it's not shown again
    state.pendingStatusLine = null;
    state.pendingAlerts = null;
    writeState(state);
  } catch (err) {
    debug(`STATUS LINE EMIT FAILED: ${err.message}`);
  }
}

// --- Context management nudges ---

function buildContextNudge(state) {
  const turnCount = state.turnCount || 0;
  const firstInput = state.firstTurnInputTokens || 0;
  const lastInput = state.lastTurnInputTokens || 0;
  const growth = firstInput > 0 && lastInput > 0 ? lastInput / firstInput : 0;

  if (turnCount > 80 || growth > 10) {
    return `\x1b[31m[Prism] ${turnCount} turns, context grew ${growth > 0 ? growth.toFixed(1) + 'x' : 'significantly'} \u2014 consider /clear to start fresh.\x1b[0m`;
  }

  if (turnCount > 20 && growth > 3) {
    return `\x1b[33m[Prism] ${turnCount} turns, context grew ${growth.toFixed(1)}x \u2014 run /compact to free context.\x1b[0m`;
  }

  if (turnCount > 0 && turnCount % 15 === 0) {
    return `\x1b[2m[Prism] ${turnCount} turns \u2014 consider /compact to keep context lean.\x1b[0m`;
  }

  return null;
}

// --- Write advisor context for the prism-advisor skill ---

function writeAdvisorContext(data, state) {
  try {
    const turnCount = state.turnCount || 0;
    const firstInput = state.firstTurnInputTokens || 0;
    const lastInput = state.lastTurnInputTokens || 0;
    const growth = firstInput > 0 && lastInput > 0 ? (lastInput / firstInput) : 0;

    const avgResponseTime = state.responseTimes && state.responseTimes.length > 0
      ? Math.round(state.responseTimes.reduce((a, b) => a + b, 0) / state.responseTimes.length)
      : null;

    const ctx = {
      sessionId: data.session_id || state.sessionId || '',
      sessionName: getSessionName(data.session_id) || null,
      cwd: data.cwd || '',
      turnCount,
      tokenGrowth: Math.round(growth * 10) / 10,
      totalInputTokens: state.totalInputTokens || 0,
      totalOutputTokens: state.totalOutputTokens || 0,
      avgResponseTimeMs: avgResponseTime,
      modelCounts: state.modelCounts || {},
      updatedAt: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(ADVISOR_CONTEXT_FILE), { recursive: true });
    fs.writeFileSync(ADVISOR_CONTEXT_FILE, JSON.stringify(ctx, null, 2));
    debug('advisor context written');
  } catch (err) {
    debug(`ADVISOR CONTEXT WRITE FAILED: ${err.message}`);
  }
}

// --- Record timestamp + capture to ingest ---

async function recordAndCapture(data, prompt) {
  try {
    const state = readState();
    state.lastPromptTimestamp = Date.now();
    writeState(state);
  } catch (err) {
    debug(`TIMESTAMP WRITE FAILED: ${err.message}`);
  }

  try {
    const result = await sendPrompt({
      prompt_text: prompt.slice(0, 2000),
      source: 'claude-code',
      tool_session_id: data.session_id,
      cwd: data.cwd,
    });
    debug(`INGEST OK: status=${result.status}`);
  } catch (err) {
    debug(`INGEST FAILED: ${err.message || err}`);
  }

  process.exit(0);
}
