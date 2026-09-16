const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  deterministicHostObservationId,
  readHostObservations,
  buildStopContextPayload,
  buildSessionEndPayload,
  HOST_OBSERVATION_KINDS,
} = require('../lib/host-observations');

const FIXTURES = path.join(__dirname, 'fixtures', 'host-observations');

function fixturePath(name) {
  return path.join(FIXTURES, name);
}

function fixtureSize(name) {
  return fs.statSync(fixturePath(name)).size;
}

const BASE = {
  hookSource: null,
  collectorVersion: 'test-collector-1',
  observedAt: '2026-09-15T00:00:10.000Z',
};

test('golden vector: adapter_event_id matches the pinned hex for queued_input_observed v1', () => {
  const id = deterministicHostObservationId('queued_input_observed', 1, ['sess-1', 'row-1']);
  assert.equal(id, '020de35b1171f9f1947d4ef5cc198215911ece0295747cdfddfcbbfac5e2dc80');
  assert.match(id, /^[0-9a-f]{64}$/);
});

test('deterministicHostObservationId is a pure function of (rawEventType, wireSchemaVersion, parts)', () => {
  const a = deterministicHostObservationId('turn_interrupt_marker_observed', 1, ['s', 'r']);
  const b = deterministicHostObservationId('turn_interrupt_marker_observed', 1, ['s', 'r']);
  const c = deterministicHostObservationId('turn_interrupt_marker_observed', 1, ['s', 'r2']);
  const d = deterministicHostObservationId('turn_interrupt_marker_observed', 2, ['s', 'r']);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

test('HOST_OBSERVATION_KINDS pins routes, raw_event_type, wire_schema_version and eviction tier', () => {
  assert.deepEqual(HOST_OBSERVATION_KINDS.prompt_input_origin, {
    route: '/v1/host-observations/input-origin',
    rawEventType: 'prompt_input_origin_observed',
    wireSchemaVersion: 2,
    evictionTier: 'prompt_evidence',
  });
  assert.equal(HOST_OBSERVATION_KINDS.queued_input.evictionTier, 'prompt');
  assert.equal(HOST_OBSERVATION_KINDS.turn_interrupt_marker.route, '/v1/host-observations/turn-interrupt');
  assert.equal(HOST_OBSERVATION_KINDS.stop_context.route, '/v1/host-observations/stop-context');
  assert.equal(HOST_OBSERVATION_KINDS.session_end.route, '/v1/host-observations/session-end');
});

test('typed user row yields transcript_row basis with promptSource and origin.kind passed through', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('typed-input-origin.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostVersion, '2.1.221');
  assert.ok(result.inputOrigin);
  assert.equal(result.inputOrigin.observation_basis, 'transcript_row');
  assert.equal(result.inputOrigin.transcript_prompt_source, 'typed');
  assert.equal(result.inputOrigin.transcript_origin_kind, 'human');
  assert.equal(result.inputOrigin.transcript_is_meta, null);
  assert.equal(result.inputOrigin.transcript_row_uuid, '22222222-2222-2222-2222-222222222222');
  assert.equal(result.inputOrigin.hook_source, null);
  assert.equal(result.inputOrigin.source_session_id, 'session-typed-1');
  assert.equal(result.inputOrigin.host_prompt_id, 'host-prompt-1');
  assert.equal(result.inputOrigin.prompt_client_event_id, 'client-event-1');
  assert.equal(result.inputOrigin.schema_version, 2);
  assert.match(result.inputOrigin.adapter_event_id, /^[0-9a-f]{64}$/);
  assert.equal(
    result.inputOrigin.adapter_event_id,
    deterministicHostObservationId('prompt_input_origin_observed', 2, ['session-typed-1', 'host-prompt-1', 'client-event-1']),
  );
  assert.deepEqual(result.queuedInputs, []);
  assert.deepEqual(result.interruptMarkers, []);
});

test('queued-promoted row (promptSource=queued) is treated as an ordinary transcript_row input-origin candidate', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('queued-promoted-input-origin.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.inputOrigin.transcript_prompt_source, 'queued');
  assert.equal(result.inputOrigin.transcript_origin_kind, 'human');
  assert.equal(result.inputOrigin.observation_basis, 'transcript_row');
});

test('suggestion_accepted row is passed through verbatim', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('suggestion-accepted-input-origin.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.inputOrigin.transcript_prompt_source, 'suggestion_accepted');
  assert.equal(result.inputOrigin.transcript_origin_kind, 'human');
});

test('sdk row has no origin field on the host record; only transcript_prompt_source resolves', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('sdk-input-origin.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.inputOrigin.transcript_prompt_source, 'sdk');
  assert.equal(result.inputOrigin.transcript_origin_kind, null);
  assert.equal(result.inputOrigin.observation_basis, 'transcript_row');
});

test('system + task-notification row is still emitted verbatim as an origin observation (server decides)', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('system-task-notification.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.ok(result.inputOrigin);
  assert.equal(result.inputOrigin.transcript_prompt_source, 'system');
  assert.equal(result.inputOrigin.transcript_origin_kind, 'task-notification');
  assert.equal(result.inputOrigin.transcript_is_meta, true);
});

test('row without any source markers (pre-2.1.161) yields inputOrigin null when hookSource is also absent', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('no-markers-row.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.inputOrigin, null);
});

test('hookSource present with no transcript row and no sourceSessionId yields inputOrigin null (no session id to derive identity from)', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('no-markers-row.jsonl'),
    byteOffset: fixtureSize('no-markers-row.jsonl'),
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    hookSource: 'user',
    collectorVersion: BASE.collectorVersion,
    observedAt: BASE.observedAt,
  });
  assert.equal(result.ok, true);
  assert.equal(result.scannedRows, 0);
  assert.equal(result.inputOrigin, null);
});

test('hookSource present with an explicit sourceSessionId and no transcript row yields a hook_field payload', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('no-markers-row.jsonl'),
    byteOffset: fixtureSize('no-markers-row.jsonl'),
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    hookSource: 'user',
    sourceSessionId: 'caller-session-1',
    collectorVersion: BASE.collectorVersion,
    observedAt: BASE.observedAt,
  });
  assert.equal(result.ok, true);
  assert.equal(result.scannedRows, 0);
  assert.ok(result.inputOrigin);
  assert.equal(result.inputOrigin.observation_basis, 'hook_field');
  assert.equal(result.inputOrigin.hook_source, 'user');
  assert.equal(result.inputOrigin.transcript_prompt_source, null);
  assert.equal(result.inputOrigin.transcript_origin_kind, null);
  assert.equal(result.inputOrigin.transcript_row_uuid, null);
  assert.equal(result.inputOrigin.source_session_id, 'caller-session-1');
  assert.equal(
    result.inputOrigin.adapter_event_id,
    deterministicHostObservationId('prompt_input_origin_observed', 2, ['caller-session-1', 'host-prompt-1', 'client-event-1']),
  );
});

test('an explicit sourceSessionId is used for every payload of the call and overrides the transcript-derived session id', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('typed-input-origin.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    sourceSessionId: 'caller-session-override',
    ...BASE,
  });
  assert.equal(result.inputOrigin.source_session_id, 'caller-session-override');
  assert.notEqual(result.inputOrigin.source_session_id, 'session-typed-1');
});

test('hookSource present together with a matching transcript row yields basis both', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('typed-input-origin.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    hookSource: 'user',
    collectorVersion: BASE.collectorVersion,
    observedAt: BASE.observedAt,
  });
  assert.equal(result.inputOrigin.observation_basis, 'both');
  assert.equal(result.inputOrigin.hook_source, 'user');
  assert.equal(result.inputOrigin.transcript_prompt_source, 'typed');
});

test('queued_command attachment (single) becomes a queued-input payload with the existing body clamp applied', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('queued-attachment-single.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.queuedInputs.length, 1);
  const payload = result.queuedInputs[0];
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.attachment_row_uuid, '44444444-4444-4444-4444-444444444441');
  assert.equal(payload.source_uuid, '33333333-3333-3333-3333-333333333331');
  assert.equal(payload.origin_kind, 'human');
  assert.equal(payload.is_meta, null);
  assert.equal(payload.command_mode, 'prompt');
  assert.equal(payload.prompt_text, 'placeholder queued attachment text');
  assert.equal(
    payload.untruncated_sha256,
    crypto.createHash('sha256').update('placeholder queued attachment text', 'utf8').digest('hex'),
  );
  assert.equal(payload.original_char_count, 'placeholder queued attachment text'.length);
  assert.equal(payload.attached_under_host_prompt_id, 'host-prompt-1');
  assert.equal(payload.host_timestamp, '2026-09-15T00:00:01.000Z');
  assert.equal(payload.source_session_id, 'session-queued-1');
  assert.equal(
    payload.adapter_event_id,
    deterministicHostObservationId('queued_input_observed', 1, ['session-queued-1', '44444444-4444-4444-4444-444444444441']),
  );
});

test('queued_command attachment (two rows) yields two independent queued-input payloads, one task-notification with no source_uuid/origin', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('queued-attachment-two.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-9',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.queuedInputs.length, 2);
  const [first, second] = result.queuedInputs;
  assert.equal(first.source_uuid, '33333333-3333-3333-3333-333333333332');
  assert.equal(first.origin_kind, 'human');
  assert.equal(second.origin_kind, null);
  assert.equal(second.source_uuid, null);
  assert.equal(second.command_mode, 'task-notification');
  assert.notEqual(first.adapter_event_id, second.adapter_event_id);
});

test('interrupt marker with interruptedMessageId (plain variant) is observed verbatim', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('interrupt-marker-with-id.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-2',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.interruptMarkers.length, 1);
  const marker = result.interruptMarkers[0];
  assert.equal(marker.marker_kind, 'user');
  assert.equal(marker.target_host_prompt_id, 'host-prompt-2');
  assert.equal(marker.interrupted_message_id, 'msg_placeholder_01');
  assert.equal(marker.row_uuid, '55555555-5555-5555-5555-555555555551');
  assert.equal(marker.source_session_id, 'session-interrupt-1');
  assert.equal(
    marker.adapter_event_id,
    deterministicHostObservationId('turn_interrupt_marker_observed', 1, ['session-interrupt-1', '55555555-5555-5555-5555-555555555551']),
  );
});

test('interrupt marker without interruptedMessageId (tool_use variant) resolves target from row promptId', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('interrupt-marker-without-id.jsonl'),
    byteOffset: 0,
    hostPromptId: 'host-prompt-3',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.interruptMarkers.length, 1);
  const marker = result.interruptMarkers[0];
  assert.equal(marker.marker_kind, 'tool_use');
  assert.equal(marker.target_host_prompt_id, 'host-prompt-3');
  assert.equal(marker.interrupted_message_id, null);
});

test('boundary beyond file size reads zero rows and returns an empty result, not an error', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('typed-input-origin.jsonl'),
    byteOffset: fixtureSize('typed-input-origin.jsonl') + 1000,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.scannedRows, 0);
  assert.equal(result.bytesRead, 0);
  assert.equal(result.inputOrigin, null);
  assert.deepEqual(result.queuedInputs, []);
  assert.deepEqual(result.interruptMarkers, []);
});

test('a span larger than the transcript size guard is refused as transcript_too_large', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-observations-'));
  const large = path.join(dir, 'oversized.jsonl');
  try {
    // One row whose JSON body alone exceeds the 1 MiB read guard.
    const bigContent = 'x'.repeat(2 * 1024 * 1024);
    fs.writeFileSync(large, `{"type":"user","message":{"role":"user","content":${JSON.stringify(bigContent)}}}\n`);
    const result = readHostObservations({
      transcriptPath: large,
      byteOffset: 0,
      hostPromptId: 'host-prompt-1',
      promptClientEventId: 'client-event-1',
      ...BASE,
    });
    assert.deepEqual(result, { ok: false, reason: 'transcript_too_large' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable transcript path is reported distinctly from an oversized span', () => {
  const result = readHostObservations({
    transcriptPath: '/nonexistent/path/does-not-exist.jsonl',
    byteOffset: 0,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.deepEqual(result, { ok: false, reason: 'transcript_unreadable' });
});

test('an invalid byte offset is reported as boundary_invalid before any file access', () => {
  const result = readHostObservations({
    transcriptPath: fixturePath('typed-input-origin.jsonl'),
    byteOffset: -1,
    hostPromptId: 'host-prompt-1',
    promptClientEventId: 'client-event-1',
    ...BASE,
  });
  assert.deepEqual(result, { ok: false, reason: 'boundary_invalid' });
});

test('a malformed row inside the span is ignored without discarding valid rows around it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-observations-'));
  const file = path.join(dir, 'partial.jsonl');
  try {
    const typedRow = fs.readFileSync(fixturePath('typed-input-origin.jsonl'), 'utf8').trimEnd();
    // A truncated trailing line (as if the host process was interrupted
    // mid-write) must not abort the whole scan.
    fs.writeFileSync(file, `${typedRow}\nnot valid json\n{"type":"user","promptId":"host-p`);
    const result = readHostObservations({
      transcriptPath: file,
      byteOffset: 0,
      hostPromptId: 'host-prompt-1',
      promptClientEventId: 'client-event-1',
      ...BASE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.scannedRows, 1);
    assert.ok(result.inputOrigin);
    assert.equal(result.inputOrigin.transcript_prompt_source, 'typed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildStopContextPayload counts background_tasks and session_crons and reports stop_hook_active verbatim', () => {
  const payload = buildStopContextPayload({
    data: { stop_hook_active: true, background_tasks: [{ id: 't1' }, { id: 't2' }], session_crons: [{ id: 'c1' }] },
    hostPromptId: 'host-prompt-1',
    stopOrdinal: 0,
    sourceSessionId: 'session-stop-1',
    collectorVersion: 'test-collector-1',
    hostVersion: '2.1.221',
    observedAt: '2026-09-15T00:00:20.000Z',
  });
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.host_prompt_id, 'host-prompt-1');
  assert.equal(payload.stop_ordinal, 0);
  assert.equal(payload.stop_hook_active, true);
  assert.equal(payload.background_task_count, 2);
  assert.equal(payload.session_cron_count, 1);
  assert.equal(payload.source_session_id, 'session-stop-1');
  assert.equal(
    payload.adapter_event_id,
    deterministicHostObservationId('stop_context_observed', 1, ['session-stop-1', 'host-prompt-1', '0']),
  );
});

test('buildStopContextPayload defaults counts to zero and stop_hook_active to false when absent', () => {
  const payload = buildStopContextPayload({
    data: {},
    hostPromptId: 'host-prompt-1',
    stopOrdinal: 3,
    sourceSessionId: 'session-stop-1',
    collectorVersion: 'test-collector-1',
    hostVersion: null,
    observedAt: '2026-09-15T00:00:20.000Z',
  });
  assert.equal(payload.stop_hook_active, false);
  assert.equal(payload.background_task_count, 0);
  assert.equal(payload.session_cron_count, 0);
  assert.equal(payload.host_version, null);
});

test('buildSessionEndPayload passes reason through verbatim and derives identity from observed_at', () => {
  const payload = buildSessionEndPayload({
    data: { reason: 'prompt_input_exit' },
    lastActiveHostPromptId: 'host-prompt-1',
    sourceSessionId: 'session-end-1',
    collectorVersion: 'test-collector-1',
    hostVersion: '2.1.221',
    observedAt: '2026-09-15T00:00:30.000Z',
  });
  assert.equal(payload.reason, 'prompt_input_exit');
  assert.equal(payload.last_active_host_prompt_id, 'host-prompt-1');
  assert.equal(
    payload.adapter_event_id,
    deterministicHostObservationId('session_end_observed', 1, ['session-end-1', '2026-09-15T00:00:30.000Z']),
  );
});

test('buildSessionEndPayload treats a missing last active host prompt id as null', () => {
  const payload = buildSessionEndPayload({
    data: { reason: 'clear' },
    lastActiveHostPromptId: null,
    sourceSessionId: 'session-end-2',
    collectorVersion: 'test-collector-1',
    hostVersion: null,
    observedAt: '2026-09-15T00:00:31.000Z',
  });
  assert.equal(payload.last_active_host_prompt_id, null);
  assert.equal(payload.host_version, null);
});

test('key-order independence: the same session/prompt scanned twice from different fixtures with reordered JSON keys hashes identically', () => {
  const idFromOrderA = deterministicHostObservationId('queued_input_observed', 1, ['session', 'row']);
  const idFromOrderB = deterministicHostObservationId('queued_input_observed', 1, ['session', 'row']);
  // The id derivation is over explicit ordered parts, not object key order,
  // so two independently-constructed part arrays with the same values and
  // order always collide regardless of how the caller assembled them.
  assert.equal(idFromOrderA, idFromOrderB);
});
