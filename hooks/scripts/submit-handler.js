#!/usr/bin/env node
/**
 * --- UserPromptSubmit Hook ---
 *
 * Captures ordinary prompts after establishing a per-session epoch barrier.
 * Prism control prompts only advance that barrier and intentionally skip every
 * other hook side effect.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
let advanceBarrier;
let attachActive;
let failBarrier;
let promoteActive;
let readState;
let writeState;
let getSessionName;

const ADVISOR_CONTEXT_FILE = path.join(os.homedir(), '.prism', 'advisor-context.json');

let debug;
let sendPrompt;

const SKIP_PATTERNS = [
  /^\//,
  /^(y|n|yes|no|ok|done|thanks|exit|quit|help|continue|go ahead|looks good|lgtm|approve)$/i,
  /^\!/,
];

function readHookStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(input));
      } catch {
        resolve({});
      }
    });
  });
}

function isPrismControlPrompt(prompt) {
  // Trimming before classification intentionally over-classifies for privacy:
  // leaking a whitespace-prefixed /prism:setup key is worse than missing a capture.
  return prompt.startsWith('/prism:');
}

function transcriptBoundary(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return { byteOffset: 0, lineOffset: 0 };
  }
  try {
    return { byteOffset: fs.statSync(transcriptPath).size, lineOffset: 0 };
  } catch {
    return { byteOffset: 0, lineOffset: 0 };
  }
}

function frozenPayload(data, prompt, clientEventId) {
  const payload = {
    prompt_text: prompt.slice(0, 2000),
    source: 'claude-code',
    tool_session_id: data.session_id || '',
    client_event_id: clientEventId,
  };
  if (data.cwd) payload.cwd = data.cwd;
  return payload;
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function responsePromptId(result) {
  if (!result || result.status < 200 || result.status >= 300) return null;
  try {
    const body = JSON.parse(result.body);
    const id = body.id || body.prompt_id || (body.data && (body.data.id || body.data.prompt_id));
    return id === null || id === undefined || id === '' ? null : id;
  } catch {
    return null;
  }
}

let activeBarrier;
let activeSessionId;

async function main() {
  const data = await readHookStdin();
  const prompt = (data.prompt || '').trim();

  if (isPrismControlPrompt(prompt)) {
    const { advanceBarrier: advanceControlBarrier } = require('../../lib/session');
    advanceControlBarrier(data.session_id, 'control');
    return;
  }

  ({
    advanceBarrier,
    attachActive,
    failBarrier,
    promoteActive,
    readState,
    writeState,
    getSessionName,
  } = require('../../lib/session'));
  const barrier = advanceBarrier(data.session_id, 'normal-pending');
  if (!barrier) return;
  activeBarrier = barrier;
  activeSessionId = data.session_id;

  const clientEventId = crypto.randomUUID();
  const payload = frozenPayload(data, prompt, clientEventId);
  const active = attachActive(data.session_id, {
    epoch: barrier.epoch,
    clientEventId,
    submittedAt: new Date().toISOString(),
    transcriptBoundary: transcriptBoundary(data.transcript_path),
    frozenPayloadHash: payloadHash(payload),
    status: 'submitting',
  });
  if (!active) return;

  const { API_KEY, INGEST_URL } = require('../../lib/env');
  debug = require('../../lib/debug').createDebug('submit-handler');
  ({ sendPrompt } = require('../../lib/ingest'));

  debug(`HOOK FIRED session_id=${data.session_id || '(none)'} prompt_length=${prompt.length} api_key=${API_KEY ? 'set' : 'missing'}`);

  if (!API_KEY || !INGEST_URL) {
    failBarrier(data.session_id, barrier.epoch);
    debug('WARN: no API key or ingest URL --- allowing prompt through');
    process.stderr.write('[Prism] API key not configured. Run /prism:setup prism_YOUR_KEY.\n');
    return;
  }

  emitPendingStatusLine();

  const shouldSkip = prompt.length < 10 || SKIP_PATTERNS.some((pattern) => pattern.test(prompt));
  if (!shouldSkip) {
    const state = readState();
    writeAdvisorContext(data, state);
    const nudge = buildContextNudge(state);
    if (nudge) process.stderr.write(nudge + '\n');
  }

  await recordAndCapture(data, payload, barrier, clientEventId);
}

main().catch((err) => {
  if (activeBarrier && failBarrier) {
    try {
      failBarrier(activeSessionId, activeBarrier.epoch);
    } catch {}
  }
  if (debug) debug(`FATAL: ${err.message || err}`);
});

function emitPendingStatusLine() {
  try {
    const state = readState();
    const lines = [];
    if (state.pendingStatusLine) lines.push(state.pendingStatusLine);
    if (state.pendingAlerts && state.pendingAlerts.length > 0) lines.push(...state.pendingAlerts);
    if (lines.length > 0) process.stderr.write(lines.join('\n') + '\n');
    state.pendingStatusLine = null;
    state.pendingAlerts = null;
    writeState(state);
  } catch (err) {
    debug(`STATUS LINE EMIT FAILED: ${err.message}`);
  }
}

function buildContextNudge(state) {
  const turnCount = state.turnCount || 0;
  const firstInput = state.firstTurnInputTokens || 0;
  const lastInput = state.lastTurnInputTokens || 0;
  const growth = firstInput > 0 && lastInput > 0 ? lastInput / firstInput : 0;

  if (turnCount > 80 || growth > 10) {
    return `\x1b[31m[Prism] ${turnCount} turns, context grew ${growth > 0 ? growth.toFixed(1) + 'x' : 'significantly'} — consider /clear to start fresh.\x1b[0m`;
  }
  if (turnCount > 20 && growth > 3) {
    return `\x1b[33m[Prism] ${turnCount} turns, context grew ${growth.toFixed(1)}x — run /compact to free context.\x1b[0m`;
  }
  if (turnCount > 0 && turnCount % 15 === 0) {
    return `\x1b[2m[Prism] ${turnCount} turns — consider /compact to keep context lean.\x1b[0m`;
  }
  return null;
}

function writeAdvisorContext(data, state) {
  try {
    const turnCount = state.turnCount || 0;
    const firstInput = state.firstTurnInputTokens || 0;
    const lastInput = state.lastTurnInputTokens || 0;
    const growth = firstInput > 0 && lastInput > 0 ? lastInput / firstInput : 0;
    const avgResponseTime = state.responseTimes && state.responseTimes.length > 0
      ? Math.round(state.responseTimes.reduce((sum, value) => sum + value, 0) / state.responseTimes.length)
      : null;
    const context = {
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
    fs.writeFileSync(ADVISOR_CONTEXT_FILE, JSON.stringify(context, null, 2));
  } catch (err) {
    debug(`ADVISOR CONTEXT WRITE FAILED: ${err.message}`);
  }
}

async function recordAndCapture(data, payload, barrier, clientEventId) {
  try {
    const state = readState();
    state.lastPromptTimestamp = Date.now();
    writeState(state);
  } catch (err) {
    debug(`TIMESTAMP WRITE FAILED: ${err.message}`);
  }

  try {
    const result = await sendPrompt(payload);
    const serverPromptId = responsePromptId(result);
    if (serverPromptId === null || !promoteActive(data.session_id, clientEventId, serverPromptId)) {
      failBarrier(data.session_id, barrier.epoch);
    }
  } catch (err) {
    failBarrier(data.session_id, barrier.epoch);
    debug(`INGEST FAILED: ${err.message || err}`);
  }
}
