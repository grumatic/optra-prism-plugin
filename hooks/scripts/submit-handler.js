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

let activeBarrier;
let activeSessionId;

async function main() {
  const data = await readHookStdin();
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (isPrismControlPrompt(prompt)) {
    require('../../lib/session').advanceBarrier(data.session_id, 'control');
    return;
  }

  ({ advanceBarrier, attachActive, failBarrier, promoteActive } = require('../../lib/session'));
  const barrier = advanceBarrier(data.session_id, 'normal-pending');
  if (!barrier) return;
  activeBarrier = barrier;
  activeSessionId = data.session_id;

  const clientEventId = crypto.randomUUID();
  const payload = frozenPayload(data, prompt, clientEventId);
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

  const { API_KEY, INGEST_URL } = require('../../lib/env');
  debug = require('../../lib/debug').createDebug('submit-handler');
  ({ sendPrompt } = require('../../lib/ingest'));
  if (!API_KEY || !INGEST_URL) {
    failBarrier(data.session_id, barrier.epoch);
    process.stderr.write('[Prism] API key not configured. Run /prism:setup prism_YOUR_KEY.\n');
    return;
  }

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
