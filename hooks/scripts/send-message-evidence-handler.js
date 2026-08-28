#!/usr/bin/env node
/**
 * Captures one successful host SendMessage occurrence. PostToolUse is the
 * host's success boundary; tool_response.success is retained only when the
 * host supplied it and never gates capture.
 */

const crypto = require('crypto');
const { readStdin } = require('../../lib/stdin');
const { buildSendMessageOccurrence } = require('../../lib/producer-evidence');
const { enqueueDetailed, recordTerminalGap, drain } = require('../../lib/response-outbox');

function gapId(data, reason) {
  const session = data && typeof data.session_id === 'string' ? data.session_id.slice(0, 1024) : '';
  const toolUse = data && typeof data.tool_use_id === 'string' ? data.tool_use_id.slice(0, 1024) : '';
  return crypto.createHash('sha256')
    .update(`prism.prompt-evidence-gap.v1\n${reason}\n${session}\n${toolUse}`)
    .digest('hex');
}

function recordGap(data, reason) {
  recordTerminalGap(gapId(data, reason), reason, {
    hook_event_name: 'PostToolUse',
    observed_at: new Date().toISOString(),
  });
}

async function main() {
  let data;
  try { data = await readStdin(); } catch { return; }
  // The hooks.json matcher is an optimization, not a trust boundary.
  if (!data || data.hook_event_name !== 'PostToolUse' || data.tool_name !== 'SendMessage') return;

  const occurrence = buildSendMessageOccurrence(data, new Date().toISOString());
  if (!occurrence.ok) {
    recordGap(data, occurrence.reason);
    return;
  }
  const entry = {
    id: `prompt-evidence-${occurrence.payload.client_event_id}`,
    kind: 'prompt_evidence',
    payload: occurrence.payload,
  };
  const publication = enqueueDetailed(entry);
  if (!['created', 'existing'].includes(publication.outcome)) {
    recordGap(data, `outbox_${publication.outcome}`);
    return;
  }

  const { API_KEY, INGEST_URL } = require('../../lib/env');
  if (!API_KEY || !INGEST_URL) return;
  const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
  await drain(deliverOutboxEntry, {
    limit: 32,
    maxElapsedMs: 2000,
    prioritizeIds: [entry.id],
  });
}

main().catch(() => {});
