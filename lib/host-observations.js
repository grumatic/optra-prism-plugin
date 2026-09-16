/**
 * Host observation collection. This module does not interpret host-recorded
 * values (promptSource, origin.kind, hook `source`, ...) — it reads what the
 * host wrote and passes it through verbatim. Classification is a server-side
 * responsibility.
 */

const crypto = require('crypto');
const fs = require('fs');
const { validHostPromptId } = require('./host-prompt-id');
const { MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES, clampToWireLimitWithEvidence } = require('./body-clamp');
const { MAX_TRANSCRIPT_BYTES } = require('./realtime');

const DOMAIN_PREFIX = 'prism.claude-code-hook-observation.';

const HOST_OBSERVATION_KINDS = {
  prompt_input_origin: {
    route: '/v1/host-observations/input-origin',
    rawEventType: 'prompt_input_origin_observed',
    wireSchemaVersion: 2,
    evictionTier: 'prompt_evidence',
  },
  queued_input: {
    route: '/v1/host-observations/queued-input',
    rawEventType: 'queued_input_observed',
    wireSchemaVersion: 1,
    evictionTier: 'prompt',
  },
  turn_interrupt_marker: {
    route: '/v1/host-observations/turn-interrupt',
    rawEventType: 'turn_interrupt_marker_observed',
    wireSchemaVersion: 1,
    evictionTier: 'prompt_evidence',
  },
  stop_context: {
    route: '/v1/host-observations/stop-context',
    rawEventType: 'stop_context_observed',
    wireSchemaVersion: 1,
    evictionTier: 'prompt_evidence',
  },
  session_end: {
    route: '/v1/host-observations/session-end',
    rawEventType: 'session_end_observed',
    wireSchemaVersion: 1,
    evictionTier: 'prompt_evidence',
  },
};

function encodePart(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function deterministicHostObservationId(rawEventType, wireSchemaVersion, parts) {
  const domain = Buffer.from(`${DOMAIN_PREFIX}${rawEventType}.v${wireSchemaVersion}\0`, 'ascii');
  const chunks = [domain, ...parts.map(encodePart)];
  return crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

function boundedString(value, maxBytes = 1024) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    ? value
    : null;
}

function boundedOrNull(value, maxBytes) {
  if (value === undefined || value === null) return null;
  return boundedString(value, maxBytes);
}

function boolOrNull(present, value) {
  return present ? Boolean(value) : null;
}

// Reads the transcript from byteOffset with the same size guard as
// lib/realtime.js's readBoundary, but distinguishes an unreadable file from
// an oversized unread span so the caller can report the right failure.
function readTranscriptSpan(transcriptPath, byteOffset) {
  if (typeof transcriptPath !== 'string' || !Number.isInteger(byteOffset) || byteOffset < 0) {
    return { ok: false, reason: 'boundary_invalid' };
  }
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return { ok: false, reason: 'transcript_unreadable' };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= byteOffset) return { ok: true, text: '', bytesRead: 0 };
    if (size - byteOffset > MAX_TRANSCRIPT_BYTES) return { ok: false, reason: 'transcript_too_large' };
    const buffer = Buffer.allocUnsafe(size - byteOffset);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, byteOffset);
    return { ok: true, text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
  } catch {
    return { ok: false, reason: 'transcript_unreadable' };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Parses newline-delimited JSON, tolerating a truncated trailing line (it
// fails JSON.parse and is dropped, same as any other malformed row).
function parseRows(text) {
  const rows = [];
  if (!text) return rows;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* ignore malformed row */ }
  }
  return rows;
}

function rowSessionId(row) {
  return boundedString(row.sessionId) || boundedString(row.session_id);
}

function isInterruptMarkerRow(row) {
  if (!row || row.type !== 'user') return false;
  if (Object.hasOwn(row, 'promptSource')) return false;
  const content = row.message && row.message.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') return false;
  if (block.text === '[Request interrupted by user]') return 'user';
  if (block.text === '[Request interrupted by user for tool use]') return 'tool_use';
  return false;
}

function isQueuedCommandAttachment(row) {
  return Boolean(row && row.type === 'attachment' && row.attachment && row.attachment.type === 'queued_command');
}

function isCandidateInputOriginRow(row, hostPromptId) {
  return Boolean(
    row
    && row.type === 'user'
    && !isInterruptMarkerRow(row)
    && Object.hasOwn(row, 'promptId')
    && boundedString(row.promptId) === hostPromptId
    && Object.hasOwn(row, 'promptSource'),
  );
}

function buildQueuedInputPayload(row, { sourceSessionId, hostPromptId, collectorVersion, hostVersion, observedAt }) {
  const attachmentRowUuid = boundedString(row.uuid, 128);
  if (!attachmentRowUuid) return null;
  const rawText = typeof row.attachment.prompt === 'string' ? row.attachment.prompt : '';
  const untruncatedSha256 = crypto.createHash('sha256').update(rawText, 'utf8').digest('hex');
  const { text: promptText } = clampToWireLimitWithEvidence(rawText, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  const attachment = row.attachment;
  return {
    schema_version: HOST_OBSERVATION_KINDS.queued_input.wireSchemaVersion,
    adapter_event_id: deterministicHostObservationId(
      HOST_OBSERVATION_KINDS.queued_input.rawEventType,
      HOST_OBSERVATION_KINDS.queued_input.wireSchemaVersion,
      [sourceSessionId, attachmentRowUuid],
    ),
    source_session_id: sourceSessionId,
    collector_version: collectorVersion,
    host_version: hostVersion,
    observed_at: observedAt,
    attachment_row_uuid: attachmentRowUuid,
    source_uuid: boundedOrNull(attachment.source_uuid, 128),
    parent_row_uuid: boundedOrNull(row.parentUuid, 128),
    origin_kind: boundedOrNull(attachment.origin && attachment.origin.kind, 64),
    is_meta: boolOrNull(Object.hasOwn(attachment, 'isMeta'), attachment.isMeta),
    command_mode: boundedOrNull(attachment.commandMode, 64),
    prompt_text: promptText,
    untruncated_sha256: untruncatedSha256,
    original_char_count: rawText.length,
    attached_under_host_prompt_id: hostPromptId,
    host_timestamp: boundedOrNull(attachment.timestamp || row.timestamp, 128),
  };
}

function buildInterruptMarkerPayload(row, markerKind, { sourceSessionId, hostPromptId, collectorVersion, hostVersion, observedAt }) {
  const rowUuid = boundedString(row.uuid, 128);
  if (!rowUuid) return null;
  const targetHostPromptId = boundedString(row.promptId) || hostPromptId;
  if (!targetHostPromptId) return null;
  return {
    schema_version: HOST_OBSERVATION_KINDS.turn_interrupt_marker.wireSchemaVersion,
    adapter_event_id: deterministicHostObservationId(
      HOST_OBSERVATION_KINDS.turn_interrupt_marker.rawEventType,
      HOST_OBSERVATION_KINDS.turn_interrupt_marker.wireSchemaVersion,
      [sourceSessionId, rowUuid],
    ),
    source_session_id: sourceSessionId,
    collector_version: collectorVersion,
    host_version: hostVersion,
    observed_at: observedAt,
    marker_kind: markerKind,
    target_host_prompt_id: targetHostPromptId,
    interrupted_message_id: boundedOrNull(row.interruptedMessageId, 128),
    row_uuid: rowUuid,
    host_timestamp: boundedOrNull(row.timestamp, 128),
  };
}

function buildInputOriginPayload(candidateRow, {
  sourceSessionId, hostPromptId, promptClientEventId, hookSource, collectorVersion, hostVersion, observedAt,
}) {
  const hasHookSource = typeof hookSource === 'string' && hookSource.length > 0;
  const transcriptPromptSource = candidateRow ? boundedOrNull(candidateRow.promptSource, 64) : null;
  const transcriptOriginKind = candidateRow
    ? boundedOrNull(candidateRow.origin && candidateRow.origin.kind, 64)
    : null;
  const transcriptRowUuid = candidateRow ? boundedOrNull(candidateRow.uuid, 128) : null;
  const hasTranscriptRow = Boolean(candidateRow) && (transcriptPromptSource !== null || transcriptOriginKind !== null) && transcriptRowUuid !== null;
  let basis;
  if (hasHookSource && hasTranscriptRow) basis = 'both';
  else if (hasHookSource) basis = 'hook_field';
  else if (hasTranscriptRow) basis = 'transcript_row';
  else return null;

  const clientEventId = boundedString(promptClientEventId);
  if (!hostPromptId || !validHostPromptId(hostPromptId) || !clientEventId || !sourceSessionId) return null;

  return {
    schema_version: HOST_OBSERVATION_KINDS.prompt_input_origin.wireSchemaVersion,
    adapter_event_id: deterministicHostObservationId(
      HOST_OBSERVATION_KINDS.prompt_input_origin.rawEventType,
      HOST_OBSERVATION_KINDS.prompt_input_origin.wireSchemaVersion,
      [sourceSessionId, hostPromptId, clientEventId],
    ),
    source_session_id: sourceSessionId,
    collector_version: collectorVersion,
    host_version: hostVersion,
    observed_at: observedAt,
    host_prompt_id: hostPromptId,
    prompt_client_event_id: clientEventId,
    hook_source: hasHookSource ? hookSource : null,
    transcript_prompt_source: transcriptPromptSource,
    transcript_origin_kind: transcriptOriginKind,
    transcript_is_meta: candidateRow ? boolOrNull(Object.hasOwn(candidateRow, 'isMeta'), candidateRow.isMeta) : null,
    transcript_row_uuid: transcriptRowUuid,
    observation_basis: basis,
  };
}

/**
 * Reads host-recorded observations from a transcript span. Pure pass-through:
 * no field is classified, only extracted and shaped into the wire payloads.
 *
 * `sourceSessionId` is the caller's own hook-input session id (identity for
 * every payload of this call). When the caller does not have one, it falls
 * back to a host-recorded value read from the transcript rows themselves
 * (every row in one transcript file belongs to the same session). If neither
 * is available, no payload can be identified and this call yields no
 * observations even where a matching structural row exists.
 */
function readHostObservations({
  transcriptPath, byteOffset, hostPromptId, promptClientEventId, hookSource, collectorVersion, observedAt,
  sourceSessionId: callerSourceSessionId,
}) {
  const span = readTranscriptSpan(transcriptPath, byteOffset);
  if (!span.ok) return { ok: false, reason: span.reason };

  const rows = parseRows(span.text);
  let sourceSessionId = boundedString(callerSourceSessionId);
  const sourceSessionIdFromCaller = Boolean(sourceSessionId);
  let hostVersion = null;
  let candidateInputOriginRow = null;
  const queuedInputs = [];
  const interruptMarkers = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (!sourceSessionIdFromCaller && !sourceSessionId) {
      const rowSession = rowSessionId(row);
      if (rowSession) sourceSessionId = rowSession;
    }
    if (typeof row.version === 'string' && row.version.length > 0) hostVersion = row.version;

    const markerKind = isInterruptMarkerRow(row);
    if (markerKind) {
      const payload = sourceSessionId
        ? buildInterruptMarkerPayload(row, markerKind, {
          sourceSessionId, hostPromptId, collectorVersion, hostVersion, observedAt,
        })
        : null;
      if (payload) interruptMarkers.push(payload);
      continue;
    }

    if (isQueuedCommandAttachment(row)) {
      const payload = sourceSessionId
        ? buildQueuedInputPayload(row, {
          sourceSessionId, hostPromptId, collectorVersion, hostVersion, observedAt,
        })
        : null;
      if (payload) queuedInputs.push(payload);
      continue;
    }

    if (!candidateInputOriginRow && isCandidateInputOriginRow(row, hostPromptId)) {
      candidateInputOriginRow = row;
    }
  }

  const inputOrigin = sourceSessionId
    ? buildInputOriginPayload(candidateInputOriginRow, {
      sourceSessionId, hostPromptId, promptClientEventId, hookSource, collectorVersion, hostVersion, observedAt,
    })
    : null;

  return {
    ok: true,
    hostVersion,
    inputOrigin,
    queuedInputs,
    interruptMarkers,
    scannedRows: rows.length,
    bytesRead: span.bytesRead,
  };
}

function buildStopContextPayload({ data, hostPromptId, stopOrdinal, sourceSessionId, collectorVersion, hostVersion, observedAt }) {
  return {
    schema_version: HOST_OBSERVATION_KINDS.stop_context.wireSchemaVersion,
    adapter_event_id: deterministicHostObservationId(
      HOST_OBSERVATION_KINDS.stop_context.rawEventType,
      HOST_OBSERVATION_KINDS.stop_context.wireSchemaVersion,
      [sourceSessionId, hostPromptId, String(stopOrdinal)],
    ),
    source_session_id: sourceSessionId,
    collector_version: collectorVersion,
    host_version: hostVersion || null,
    observed_at: observedAt,
    host_prompt_id: hostPromptId,
    stop_ordinal: stopOrdinal,
    stop_hook_active: Boolean(data && data.stop_hook_active),
    background_task_count: Array.isArray(data && data.background_tasks) ? data.background_tasks.length : 0,
    session_cron_count: Array.isArray(data && data.session_crons) ? data.session_crons.length : 0,
  };
}

function buildSessionEndPayload({ data, lastActiveHostPromptId, sourceSessionId, collectorVersion, hostVersion, observedAt }) {
  return {
    schema_version: HOST_OBSERVATION_KINDS.session_end.wireSchemaVersion,
    adapter_event_id: deterministicHostObservationId(
      HOST_OBSERVATION_KINDS.session_end.rawEventType,
      HOST_OBSERVATION_KINDS.session_end.wireSchemaVersion,
      [sourceSessionId, observedAt],
    ),
    source_session_id: sourceSessionId,
    collector_version: collectorVersion,
    host_version: hostVersion || null,
    observed_at: observedAt,
    reason: boundedOrNull(data && data.reason, 64) || 'other',
    last_active_host_prompt_id: boundedOrNull(lastActiveHostPromptId, 1024),
  };
}

module.exports = {
  deterministicHostObservationId,
  readHostObservations,
  buildStopContextPayload,
  buildSessionEndPayload,
  HOST_OBSERVATION_KINDS,
};
