#!/usr/bin/env node
/**
 * Captures a normal UserPromptSubmit after creating an epoch-scoped active
 * record. The host prompt_id is retained only as an opaque correlation token.
 */

const crypto = require('crypto');
const fs = require('fs');
let debug;
let advanceBarrier;
let attachActive;
let failBarrier;
let promoteActive;
let readTurn;
let sendPrompt;
let sendResponse;
let enqueue;
let drain;
let readGit;
let writeGit;
let collectGitContext;
const systemMessages = [];

const MAX_SYSTEM_MESSAGE_LENGTH = 10_000;
function readHookStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(input)); } catch { resolve({}); }
    });
  });
}

function validPromptId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}
function persistedServerPromptId(body) {
  try {
    const parsed = JSON.parse(body);
    const { validServerPromptId } = require('../../lib/session');
    return parsed && validServerPromptId(parsed.id) ? parsed.id : null;
  } catch {
    return null;
  }
}
function isTerminalDroppedPromptAck(body) {
  try {
    return JSON.parse(body).id === '00000000-0000-0000-0000-000000000000';
  } catch {
    return false;
  }
}

function promptIsPromoted(entry, serverPromptId) {
  const promotion = entry.promotion;
  if (!promotion || !serverPromptId) return !promotion;
  const promoted = promoteActive(
    promotion.sessionId,
    promotion.clientEventId,
    promotion.hostPromptId,
    serverPromptId,
  );
  if (promoted) return true;
  const turn = readTurn(promotion.sessionId);
  return Boolean(
    turn
    && turn.epoch === promotion.epoch
    && turn.active
    && turn.active.clientEventId === promotion.clientEventId
    && turn.active.submitPromptId === promotion.hostPromptId
    && turn.active.serverPromptId === serverPromptId
    && ['captured', 'consumed'].includes(turn.active.status),
  );
}

async function deliverOutboxEntry(entry, options) {
  const result = await (entry.kind === 'prompt' ? sendPrompt(entry.payload, options) : sendResponse(entry.payload, options));
  if (entry.kind !== 'prompt' || !result || result.status < 200 || result.status >= 300) return result;
  return {
    ...result,
    // Ingest uses 200 plus the nil UUID for intentionally dropped internal
    // utility prompts. It is terminal, but must not promote a server prompt id.
    ack: isTerminalDroppedPromptAck(result.body)
      || promptIsPromoted(entry, persistedServerPromptId(result.body)),
  };
}


function isPrismControlPrompt(prompt) {
  return /^[\x00-\x1F\s]*\/prism:/i.test(prompt);
}

function transcriptBoundary(transcriptPath) {
  if (typeof transcriptPath !== 'string') return { byteOffset: 0, lineOffset: 0 };
  try { return { byteOffset: fs.statSync(transcriptPath).size, lineOffset: 0 }; } catch { return { byteOffset: 0, lineOffset: 0 }; }
}

function frozenPayload(data, prompt, clientEventId, git) {
  const payload = {
    prompt_text: prompt.slice(0, 2000),
    source: 'claude-code',
    tool_session_id: data.session_id || '',
    client_event_id: clientEventId,
  };
  if (data.cwd) payload.cwd = data.cwd;
  if (git) payload.metadata = { git };
  return payload;
}

async function gitMetadataForPrompt(data) {
  if (typeof data.cwd !== 'string' || data.cwd.length === 0) return null;

  let canonicalCwd;
  try {
    canonicalCwd = fs.realpathSync.native(data.cwd);
  } catch {
    return null;
  }

  let record = readGit(data.session_id);
  const refreshedAt = record && record.refreshedAt ? Date.parse(record.refreshedAt) : NaN;
  if (
    !record
    || record.canonicalCwd !== canonicalCwd
    || !Number.isFinite(refreshedAt)
    || Date.now() - refreshedAt >= 30_000
  ) {
    try {
      const context = await collectGitContext(canonicalCwd);
      record = writeGit(data.session_id, context);
    } catch {
      return null;
    }
  }

  return record
    && record.status === 'ok'
    && record.canonicalCwd === canonicalCwd
    && record.value
    ? record.value
    : null;
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

let activeBarrier;
let activeSessionId;

function queueSystemMessage(message, enabled = true) {
  if (!enabled || !message) return;
  systemMessages.push(message);
}

function emitSystemMessages() {
  if (systemMessages.length === 0) return;
  process.stdout.write(`${JSON.stringify({
    systemMessage: systemMessages.join('\n').slice(0, MAX_SYSTEM_MESSAGE_LENGTH),
  })}\n`);
}

async function main() {
  const data = await readHookStdin();
  const prompt = data && data.prompt;
  const isStringPrompt = typeof prompt === 'string';
  const isControlPrompt = !isStringPrompt || isPrismControlPrompt(prompt);

  ({ advanceBarrier, attachActive, failBarrier, promoteActive, readTurn, readGit, writeGit } = require('../../lib/session'));
  const barrier = advanceBarrier(
    data && data.session_id,
    isControlPrompt ? 'control' : 'normal-pending',
  );
  if (!barrier) return;
  if (!isControlPrompt) {
    activeBarrier = barrier;
    activeSessionId = data.session_id;
  }

  if (isStringPrompt) {
    try {
      const { activatePluginVersion } = require('../../lib/plugin-activation');
      const activation = activatePluginVersion({
        pluginRoot: process.env.CLAUDE_PLUGIN_ROOT
          || require('node:path').resolve(__dirname, '../..'),
        dataDir: process.env.CLAUDE_PLUGIN_DATA,
        projectDir: process.env.CLAUDE_PROJECT_DIR || data.cwd,
      });
      queueSystemMessage(activation && activation.notice);
    } catch {}
  }

  if (isControlPrompt) return;
  const normalizedPrompt = prompt.trim();

  ({ collectGitContext } = require('../../lib/git'));
  const git = await gitMetadataForPrompt(data);
  const clientEventId = crypto.randomUUID();
  const payload = frozenPayload(data, normalizedPrompt, clientEventId, git);
  const activeRecord = {
    epoch: barrier.epoch,
    clientEventId,
    submittedAt: new Date().toISOString(),
    transcriptBoundary: transcriptBoundary(data.transcript_path),
    frozenPayloadHash: payloadHash(payload),
    status: 'submitting',
  };
  if (validPromptId(data.prompt_id)) activeRecord.submitPromptId = data.prompt_id;
  if (!attachActive(data.session_id, activeRecord)) return;

  const { API_KEY, INGEST_URL, SHOW_REALTIME_SUMMARY } = require('../../lib/env');
  debug = require('../../lib/debug').createDebug('submit-handler');
  ({ sendPrompt, sendResponse } = require('../../lib/ingest'));
  ({ enqueue, drain } = require('../../lib/response-outbox'));
  if (!API_KEY) {
    failBarrier(data.session_id, barrier.epoch);
    queueSystemMessage(
      '[Prism] API key not configured. Run /prism:setup YOUR_KEY.',
      SHOW_REALTIME_SUMMARY,
    );
    return;
  }
  if (!INGEST_URL) {
    failBarrier(data.session_id, barrier.epoch);
    queueSystemMessage(
      '[Prism] ingest_url not configured. Run /prism:setup YOUR_KEY or /prism:config.',
      SHOW_REALTIME_SUMMARY,
    );
    return;
  }

  const outboxId = `prompt-${clientEventId}`;
  if (!enqueue({
    id: outboxId,
    kind: 'prompt',
    payload,
    promotion: {
      sessionId: data.session_id,
      epoch: barrier.epoch,
      clientEventId,
      hostPromptId: data.prompt_id,
    },
  })) {
    failBarrier(data.session_id, barrier.epoch);
    return;
  }

  await drain(deliverOutboxEntry, {
    limit: 32,
    maxElapsedMs: 2000,
    prioritizeIds: [outboxId],
  });
}

main()
  .catch((err) => {
    if (activeBarrier && failBarrier) {
      try { failBarrier(activeSessionId, activeBarrier.epoch); } catch {}
    }
    if (debug) debug(`FATAL: ${err.message || err}`);
  })
  .finally(() => {
    emitSystemMessages();
  });
