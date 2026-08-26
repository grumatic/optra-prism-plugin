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
let unavailablePromptGitMetadata;
let MAX_PROMPT_BODY_BYTES;
let MAX_WIRE_BYTES;
let clampToWireLimit;
let clampToWireLimitWithEvidence;
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

function frozenPayload(data, prompt, clientEventId, git, hostPromptId, producerEvidence) {
  // `prompt` is the legacy trimmed body. Producer evidence is separately
  // frozen from raw hook context before that normalization (in main()).
  // Hash the untruncated prompt once, before clamping, so the server can
  // prove what the full body was without the plugin reading or storing it
  // twice. original_char_count is in UTF-16 code units (JS string length);
  // the clamp itself is byte-bounded (see lib/body-clamp.js).
  const untruncatedSha256 = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  const { text: clampedPrompt, sizeClamped: promptSizeClamped } = clampToWireLimitWithEvidence(
    prompt,
    MAX_PROMPT_BODY_BYTES,
    MAX_WIRE_BYTES,
  );
  const payload = {
    prompt_text: clampedPrompt,
    source: 'claude-code',
    tool_session_id: data.session_id || '',
    client_event_id: clientEventId,
    original_char_count: prompt.length,
    untruncated_sha256: untruncatedSha256,
    truncated: clampedPrompt !== prompt,
  };
  // A path this long is degenerate — truncate silently, no evidence fields
  // needed (unlike prompt_text, cwd carries no server-side contract limit;
  // this cap exists only to close the last unbounded contributor to
  // MAX_ENTRY_BYTES's envelope margin, see lib/response-outbox.js).
  if (data.cwd) payload.cwd = clampToWireLimit(data.cwd, MAX_CWD_BYTES, MAX_CWD_BYTES);
  // producerEvidence is frozen immediately after JSON parsing, before trim,
  // clamp, or asynchronous git collection. It is execution context only:
  // neither a literal tag nor absent agent context establishes a producer.
  payload.metadata = {
    ...(git ? { git } : {}),
    ...(producerEvidence ? { producer_evidence: producerEvidence } : {}),
    // Metadata is deliberately extensible on the legacy prompt contract.
    // Emit this only for an actual decoded/wire size prefix clamp: false is
    // indistinguishable from older plugin payloads, and `truncated` still
    // records lone-surrogate scrubbing separately.
    ...(promptSizeClamped ? { prompt_size_clamped: true } : {}),
  };
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

  const cached = readGit(data.session_id);
  const refreshedAt = cached && cached.refreshedAt ? Date.parse(cached.refreshedAt) : NaN;
  const needsRefresh = !cached
    || cached.canonicalCwd !== canonicalCwd
    || !Number.isFinite(refreshedAt)
    || Date.now() - refreshedAt >= 30_000;

  // Decide from the envelope this call itself observed (fresh, or the still-
  // valid cache), never from writeGit's merged return: the preserve-last-good
  // branch there can rewrite canonicalCwd to a stale value and fail the guard
  // below for what is actually a fresh, matching observation.
  let envelope = cached;
  if (needsRefresh) {
    try {
      const context = await collectGitContext(canonicalCwd);
      envelope = context;
      writeGit(data.session_id, context);
    } catch {
      return null;
    }
  }

  if (!envelope || envelope.canonicalCwd !== canonicalCwd) return null;
  if (envelope.status === 'ok' && envelope.value) return envelope.value;
  // A preserved-last-good value is never sent here: a non-'ok' status always
  // carries this attempt's own reason, never the stale value's timestamp.
  if (envelope.status !== 'ok' && envelope.reason) {
    return unavailablePromptGitMetadata(envelope.reason, envelope.attemptedAt);
  }
  return null;
}

function payloadHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function receiveEvidenceValidation(data) {
  const { validHostPromptId } = require('../../lib/host-prompt-id');
  if (!data || typeof data.session_id !== 'string' || data.session_id.length === 0
    || Buffer.byteLength(data.session_id, 'utf8') > 1024 || !validHostPromptId(data.prompt_id)) {
    return { ok: false, reason: 'prompt_producer_evidence_invalid' };
  }
  const { optionalContextState } = require('../../lib/producer-evidence');
  const context = optionalContextState(data);
  return context.ok
    ? { ok: true }
    : { ok: false, reason: `prompt_producer_evidence_${context.reason}` };
}

function recordReceiveEvidenceGap(data, reason) {
  const { recordTerminalGap } = require('../../lib/response-outbox');
  const session = data && typeof data.session_id === 'string' ? data.session_id : '';
  const prompt = data && typeof data.prompt_id === 'string' ? data.prompt_id : '';
  const id = crypto.createHash('sha256')
    .update(`prism.prompt-producer-evidence.receive-gap.v1\n${reason}\n${session}\n${prompt}`)
    .digest('hex');
  recordTerminalGap(id, reason, {
    hook_event_name: 'UserPromptSubmit',
    observed_at: new Date().toISOString(),
  });
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
  const observedAt = new Date().toISOString();
  const { observeUserPromptSubmit } = require('../../lib/producer-evidence');
  const producerEvidence = observeUserPromptSubmit(data, observedAt);
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
  if (hostPromptPresent && !validHostPromptId(data.prompt_id)) {
    recordReceiveEvidenceGap(data, 'prompt_producer_evidence_invalid');
    return;
  }
  const receiveEvidence = receiveEvidenceValidation(data);
  if (!receiveEvidence.ok) recordReceiveEvidenceGap(data, receiveEvidence.reason);
  const hostPromptId = validHostPromptId(data && data.prompt_id) ? data.prompt_id : null;
  const normalizedPrompt = prompt.trim();

  ({ collectGitContext } = require('../../lib/git'));
  ({ unavailablePromptGitMetadata } = require('../../lib/git-evidence-contract'));
  ({
    MAX_PROMPT_BODY_BYTES,
    MAX_WIRE_BYTES,
    clampToWireLimit,
    clampToWireLimitWithEvidence,
  } = require('../../lib/body-clamp'));
  const git = await gitMetadataForPrompt(data);
  const clientEventId = crypto.randomUUID();
  const payload = frozenPayload(
    data,
    normalizedPrompt,
    clientEventId,
    git,
    hostPromptId,
    receiveEvidence.ok ? producerEvidence : null,
  );
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
