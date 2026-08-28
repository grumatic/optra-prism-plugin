/**
 * Frozen host-adapter evidence. This module deliberately transports host
 * observations without deriving a sender from message text or agent context.
 */

const crypto = require('crypto');
const { validHostPromptId } = require('./host-prompt-id');

const EVIDENCE_NAMESPACE = 'prism.prompt-producer-evidence';
const EVIDENCE_SCHEMA_VERSION = 1;
const MAX_CONTEXT_VALUE_BYTES = 1024;
const MAX_EVIDENCE_REQUEST_BYTES = 128 * 1024;

function boundedString(value, maximum = MAX_CONTEXT_VALUE_BYTES) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maximum
    ? value
    : null;
}

function optionalContextState(data) {
  const values = {};
  for (const field of ['agent_id', 'agent_type']) {
    if (!data || !Object.hasOwn(data, field)) continue;
    const value = data[field];
    if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'invalid' };
    if (Buffer.byteLength(value, 'utf8') > MAX_CONTEXT_VALUE_BYTES) return { ok: false, reason: 'exceeds_limit' };
    values[field] = value;
  }
  return { ok: true, values };
}

function observationBase(data, evidenceType, observedAt) {
  const sessionId = boundedString(data && data.session_id);
  const promptId = boundedString(data && data.prompt_id);
  return {
    namespace: EVIDENCE_NAMESPACE,
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_type: evidenceType,
    producer_kind: 'UNKNOWN',
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(promptId ? { prompt_id: promptId } : {}),
    ...optionalContextState(data).values,
    observed_at: observedAt,
  };
}

function observeUserPromptSubmit(data, observedAt = new Date().toISOString()) {
  return {
    ...observationBase(data, 'user_prompt_submit_received', observedAt),
    hook_event_name: 'UserPromptSubmit',
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function deterministicEvidenceId(sourceSessionId, toolUseId) {
  const domain = Buffer.from('prism.prompt-evidence.client-event-id.v1\0', 'ascii');
  const encode = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  };
  return crypto.createHash('sha256').update(Buffer.concat([
    domain,
    encode(sourceSessionId),
    encode(toolUseId),
  ])).digest('hex');
}

function boundedHostResult(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return null; }
  if (serialized === undefined) return null;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const success = value && typeof value === 'object' && !Array.isArray(value) && typeof value.success === 'boolean'
    ? { success: value.success }
    : {};
  return {
    response_type: value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value),
    response_byte_count: bytes,
    response_sha256: sha256(serialized),
    ...success,
  };
}

function buildSendMessageOccurrence(data, observedAt = new Date().toISOString()) {
  if (!data || data.hook_event_name !== 'PostToolUse' || data.tool_name !== 'SendMessage') {
    return { ok: false, reason: 'not_successful_send_message_hook' };
  }
  const sourceSessionId = boundedString(data.session_id);
  const hostPromptId = boundedString(data.prompt_id);
  const toolUseId = boundedString(data.tool_use_id);
  const toolInput = data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input)
    ? data.tool_input
    : null;
  const message = toolInput && typeof toolInput.message === 'string' ? toolInput.message : null;
  if (!sourceSessionId || !hostPromptId || !validHostPromptId(hostPromptId) || !toolUseId || message === null) {
    return { ok: false, reason: 'invalid_send_message_host_input' };
  }
  const context = optionalContextState(data);
  if (!context.ok) return { ok: false, reason: `prompt_evidence_${context.reason}` };

  // Claude Code's native SendMessage shape uses `to`; retain older host
  // aliases without interpreting or normalizing the opaque identifier.
  const recipient = boundedString(toolInput.to)
    || boundedString(toolInput.recipient)
    || boundedString(toolInput.teammate);
  if (!recipient) return { ok: false, reason: 'invalid_send_message_recipient' };
  const hostSuccess = boundedHostResult(data.tool_response);
  if (!hostSuccess) return { ok: false, reason: 'invalid_send_message_host_result' };
  const producerEvidence = {
    ...observationBase(data, 'send_message_sent', observedAt),
    producer_kind: 'AGENT',
    hook_event_name: 'PostToolUse',
  };
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    client_event_id: deterministicEvidenceId(sourceSessionId, toolUseId),
    source_session_id: sourceSessionId,
    host_prompt_id: hostPromptId,
    tool_use_id: toolUseId,
    producer_evidence: producerEvidence,
    recipient,
    message_byte_count: Buffer.byteLength(message, 'utf8'),
    message_sha256: sha256(message),
    host_success: hostSuccess,
  };
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_EVIDENCE_REQUEST_BYTES) return { ok: false, reason: 'prompt_evidence_body_exceeds_limit' };
  return { ok: true, payload };
}

module.exports = {
  EVIDENCE_NAMESPACE,
  EVIDENCE_SCHEMA_VERSION,
  MAX_CONTEXT_VALUE_BYTES,
  MAX_EVIDENCE_REQUEST_BYTES,
  observeUserPromptSubmit,
  optionalContextState,
  deterministicEvidenceId,
  buildSendMessageOccurrence,
};
