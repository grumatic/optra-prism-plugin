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
let readTurn;
let enqueue;
let drain;
let readGit;
let writeGit;
let collectGitContext;
let MAX_PROMPT_BODY_BYTES;
let MAX_WIRE_BYTES;
let clampToWireLimit;
const systemMessages = [];

const MAX_SYSTEM_MESSAGE_LENGTH = 10_000;
const MAX_CWD_BYTES = 8 * 1024;
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

function isPrismControlPrompt(prompt) {
  return /^[\x00-\x1F\s]*\/prism:/i.test(prompt);
}

function transcriptBoundary(transcriptPath) {
  if (typeof transcriptPath !== 'string') return { byteOffset: 0, lineOffset: 0 };
  try { return { byteOffset: fs.statSync(transcriptPath).size, lineOffset: 0 }; } catch { return { byteOffset: 0, lineOffset: 0 }; }
}

function frozenPayload(data, prompt, clientEventId, git, hostPromptId) {
  const untruncatedSha256 = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  const clampedPrompt = clampToWireLimit(prompt, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  const payload = {
    prompt_text: clampedPrompt,
    source: 'claude-code',
    tool_session_id: data.session_id || '',
    client_event_id: clientEventId,
    original_char_count: prompt.length,
    untruncated_sha256: untruncatedSha256,
    truncated: clampedPrompt !== prompt,
  };
  // cwd carries no server-side contract limit; this cap only bounds the outbox entry's envelope margin.
  if (data.cwd) payload.cwd = clampToWireLimit(data.cwd, MAX_CWD_BYTES, MAX_CWD_BYTES);
  if (git) payload.metadata = { git };
  if (hostPromptId) payload.host_prompt_id = hostPromptId;
  // Client-observed submit time. The outbox can deliver this payload long
  // after submit, and the server's receipt time would misplace the turn.
  // Keep it last: sendPrompt rebuilds the body in this key order, and the
  // frozen payload hash compares the serialized forms.
  payload.submitted_at = new Date().toISOString();
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

  ({ advanceBarrier, attachActive, failBarrier, readTurn, readGit, writeGit } = require('../../lib/session'));
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
  const { validHostPromptId } = require('../../lib/host-prompt-id');
  const hostPromptPresent = data && typeof data === 'object' && Object.hasOwn(data, 'prompt_id');
  if (hostPromptPresent && !validHostPromptId(data.prompt_id)) return;
  const hostPromptId = validHostPromptId(data && data.prompt_id) ? data.prompt_id : null;
  const normalizedPrompt = prompt.trim();

  ({ collectGitContext } = require('../../lib/git'));
  ({ MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES, clampToWireLimit } = require('../../lib/body-clamp'));
  const git = await gitMetadataForPrompt(data);
  const clientEventId = crypto.randomUUID();
  const payload = frozenPayload(data, normalizedPrompt, clientEventId, git, hostPromptId);
  const activeRecord = {
    epoch: barrier.epoch,
    clientEventId,
    submittedAt: new Date().toISOString(),
    transcriptBoundary: transcriptBoundary(data.transcript_path),
    frozenPayloadHash: payloadHash(payload),
    status: 'submitting',
  };
  if (hostPromptId) activeRecord.submitPromptId = hostPromptId;
  if (!attachActive(data.session_id, activeRecord)) return;

  const { API_KEY, INGEST_URL, SHOW_REALTIME_SUMMARY } = require('../../lib/env');
  debug = require('../../lib/debug').createDebug('submit-handler');
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
  const promptIntent = {
    id: outboxId,
    kind: 'prompt',
    payload,
  };
  if (hostPromptId) {
    promptIntent.promotion = {
      sessionId: data.session_id,
      epoch: barrier.epoch,
      clientEventId,
      hostPromptId,
      identityMode: 'exact',
    };
  } else {
    promptIntent.legacyPromotion = {
      sessionId: data.session_id,
      epoch: barrier.epoch,
      clientEventId,
    };
  }
  if (!enqueue(promptIntent)) {
    failBarrier(data.session_id, barrier.epoch);
    return;
  }

  const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
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
