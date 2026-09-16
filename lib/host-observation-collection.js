/**
 * Orchestrates host observation collection across the three trigger points
 * (Stop, the next UserPromptSubmit, SessionEnd): reads the transcript span
 * once via lib/host-observations.js, then enqueues whatever it finds onto
 * the durable outbox, skipping any kind an old server has already marked
 * unsupported for this session. Never throws — every entry point here is a
 * best-effort side channel that must not affect prompt/response delivery.
 */

const {
  readHostObservations,
  buildStopContextPayload,
  buildSessionEndPayload,
  HOST_OBSERVATION_KINDS,
} = require('./host-observations');
const crypto = require('crypto');
const { enqueue, recordTerminalGap } = require('./response-outbox');
const {
  isKindUnsupported,
  readHookSource,
  recordHookSource,
  nextStopOrdinal,
} = require('./host-observation-state');

function outboxId(kind, adapterEventId) {
  return `host-observation-${kind}-${adapterEventId}`;
}

// Records that a read attempt for one host_prompt_id could not observe
// anything, once per (session, host_prompt_id, reason). The design's "never
// silent" principle applies to the server's `unresolved` handling of missing
// evidence, not to this local gap record — it exists only as debuggable
// telemetry, and its dedup means calling it from more than one of the three
// read sites for the same failure is harmless.
function recordHostObservationGap(sessionId, hostPromptId, reason) {
  const session = typeof sessionId === 'string' ? sessionId : '';
  const prompt = typeof hostPromptId === 'string' ? hostPromptId : '';
  const id = crypto.createHash('sha256')
    .update(`prism.host-observation.receive-gap.v1\n${reason}\n${session}\n${prompt}`)
    .digest('hex');
  try {
    recordTerminalGap(id, reason, { source_session_id: session, host_prompt_id: prompt, observed_at: new Date().toISOString() });
  } catch { /* best-effort */ }
}

// Enqueues one already-built host observation payload, honoring the
// old-server "unsupported" skip (contract §5.4: once a kind is known
// unsupported for a session, no further entry of that kind is even created).
// Returns the outbox id it was enqueued (or already durably present) under,
// so a caller can later restrict a bounded drain to exactly these entries;
// returns null when nothing was enqueued.
function enqueueHostObservation(sessionId, kind, payload, { dependsOn } = {}) {
  if (!payload || !HOST_OBSERVATION_KINDS[kind]) return null;
  if (isKindUnsupported(sessionId, kind)) return null;
  const id = outboxId(kind, payload.adapter_event_id);
  const entry = {
    id,
    kind,
    payload,
    ...(dependsOn ? { dependsOn } : {}),
  };
  return enqueue(entry) ? id : null;
}

/**
 * Reads a transcript span (the boundary of one active record, either the
 * still-open one at Stop or the just-superseded one at the next
 * UserPromptSubmit) and enqueues every observation it finds. `promptOutboxId`
 * is the deterministic id of that record's own `prompt` outbox entry: only
 * the input-origin kind depends on it (contract §5.2), the rest are
 * independent.
 * @returns {{ ok: boolean, hostVersion: string|null, reason?: string, enqueuedIds: string[] }}
 */
function collectAndEnqueueHostObservations({
  sessionId, transcriptPath, byteOffset, hostPromptId, clientEventId, promptOutboxId, collectorVersion, observedAt,
}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof hostPromptId !== 'string' || hostPromptId.length === 0) {
    return { ok: false, hostVersion: null, reason: 'host_observation_missing_identity', enqueuedIds: [] };
  }
  const hookSource = readHookSource(sessionId, hostPromptId);
  let result;
  try {
    result = readHostObservations({
      transcriptPath,
      byteOffset,
      hostPromptId,
      promptClientEventId: clientEventId,
      hookSource,
      collectorVersion,
      observedAt,
      sourceSessionId: sessionId,
    });
  } catch {
    recordHostObservationGap(sessionId, hostPromptId, 'host_observation_read_threw');
    return { ok: false, hostVersion: null, reason: 'host_observation_read_threw', enqueuedIds: [] };
  }
  if (!result.ok) {
    recordHostObservationGap(sessionId, hostPromptId, result.reason);
    return { ok: false, hostVersion: null, reason: result.reason, enqueuedIds: [] };
  }

  const enqueuedIds = [];
  if (result.inputOrigin) {
    const id = enqueueHostObservation(sessionId, 'prompt_input_origin', result.inputOrigin, { dependsOn: promptOutboxId });
    if (id) enqueuedIds.push(id);
  }
  for (const payload of result.queuedInputs) {
    const id = enqueueHostObservation(sessionId, 'queued_input', payload);
    if (id) enqueuedIds.push(id);
  }
  for (const payload of result.interruptMarkers) {
    const id = enqueueHostObservation(sessionId, 'turn_interrupt_marker', payload);
    if (id) enqueuedIds.push(id);
  }

  return { ok: true, hostVersion: result.hostVersion, enqueuedIds };
}

// Returns the enqueued outbox id, or null.
function enqueueStopContext({ sessionId, data, hostPromptId, collectorVersion, hostVersion, observedAt }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof hostPromptId !== 'string' || hostPromptId.length === 0) {
    return null;
  }
  const stopOrdinal = nextStopOrdinal(sessionId, hostPromptId);
  const payload = buildStopContextPayload({
    data, hostPromptId, stopOrdinal, sourceSessionId: sessionId, collectorVersion, hostVersion, observedAt,
  });
  return enqueueHostObservation(sessionId, 'stop_context', payload);
}

// Returns the enqueued outbox id, or null.
function enqueueSessionEnd({ sessionId, data, lastActiveHostPromptId, collectorVersion, hostVersion, observedAt }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const payload = buildSessionEndPayload({
    data, lastActiveHostPromptId, sourceSessionId: sessionId, collectorVersion, hostVersion, observedAt,
  });
  return enqueueHostObservation(sessionId, 'session_end', payload);
}

module.exports = {
  enqueueHostObservation,
  collectAndEnqueueHostObservations,
  enqueueStopContext,
  enqueueSessionEnd,
  recordHookSource,
  recordHostObservationGap,
};
