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
let sendPrompt;
let readGit;
let writeGit;
let collectGitContext;
let readSummary;

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
    return parsed && validPromptId(parsed.id) ? parsed.id : null;
  } catch {
    return null;
  }
}


function isPrismControlPrompt(prompt) {
  return prompt.startsWith('/prism:');
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
function buildContextNudge(summary) {
  const health = summary && summary.contextHealth;
  if (!health || typeof health !== 'object') return null;

  const { growth } = require('../../lib/realtime').gradeFor(health);
  const turnCount = Number.isInteger(health.turnCount) ? health.turnCount : 0;
  const growthLabel = Number.isFinite(growth) ? growth.toFixed(1) : '0.0';

  if (growth > 10 || turnCount > 80) {
    if (growth > 10 && turnCount > 80) {
      return `[Prism] Context has grown ${growthLabel}× over ${turnCount} turns — consider /clear to start fresh.`;
    }
    if (growth > 10) {
      return `[Prism] Context has grown ${growthLabel}× since this session began — consider /clear to start fresh.`;
    }
    return `[Prism] Context has reached ${turnCount} turns — consider /clear to start fresh.`;
  }
  if (growth > 3) {
    return `[Prism] Context has grown ${growthLabel}× since this session began — run /compact to free context.`;
  }
  return null;
}

function emitSystemMessage(message, showRealtimeSummary) {
  if (!showRealtimeSummary || !message) return;
  process.stdout.write(`${JSON.stringify({
    systemMessage: message.slice(0, MAX_SYSTEM_MESSAGE_LENGTH),
  })}\n`);
}

async function main() {
  const data = await readHookStdin();
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (isPrismControlPrompt(prompt)) {
    require('../../lib/session').advanceBarrier(data.session_id, 'control');
    return;
  }

  ({ advanceBarrier, attachActive, failBarrier, promoteActive, readGit, writeGit, readSummary } = require('../../lib/session'));
  const barrier = advanceBarrier(data.session_id, 'normal-pending');
  if (!barrier) return;
  activeBarrier = barrier;
  activeSessionId = data.session_id;

  ({ collectGitContext } = require('../../lib/git'));
  const git = await gitMetadataForPrompt(data);
  const clientEventId = crypto.randomUUID();
  const payload = frozenPayload(data, prompt, clientEventId, git);
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
  ({ sendPrompt } = require('../../lib/ingest'));
  if (!API_KEY || !INGEST_URL) {
    failBarrier(data.session_id, barrier.epoch);
    emitSystemMessage(
      '[Prism] API key not configured. Run /prism:setup prism_YOUR_KEY.',
      SHOW_REALTIME_SUMMARY,
    );
    return;
  }
  const nudge = buildContextNudge(readSummary(data.session_id));
  emitSystemMessage(nudge, SHOW_REALTIME_SUMMARY);

  try {
    const result = await sendPrompt(payload);
    const serverPromptId = persistedServerPromptId(result.body);
    if (
      !(result.status >= 200 && result.status < 300)
      || !serverPromptId
      || !validPromptId(data.prompt_id)
      || !promoteActive(data.session_id, clientEventId, data.prompt_id)
    ) {
      failBarrier(data.session_id, barrier.epoch);
    }
  } catch (err) {
    failBarrier(data.session_id, barrier.epoch);
    debug(`INGEST FAILED: ${err.message || err}`);
  }
}

main().catch((err) => {
  if (activeBarrier && failBarrier) {
    try { failBarrier(activeSessionId, activeBarrier.epoch); } catch {}
  }
  if (debug) debug(`FATAL: ${err.message || err}`);
});
