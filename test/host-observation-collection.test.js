const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

let dataDir;

function resetModules() {
  for (const name of ['../lib/host-observation-state', '../lib/host-observation-collection', '../lib/response-outbox']) {
    delete require.cache[require.resolve(name)];
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-host-observation-collection-'));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  resetModules();
});

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('enqueueHostObservation is skipped once a kind is marked unsupported for the session', () => {
  const outbox = require('../lib/response-outbox');
  const state = require('../lib/host-observation-state');
  const { enqueueHostObservation } = require('../lib/host-observation-collection');
  const payload = {
    schema_version: 1,
    adapter_event_id: 'a'.repeat(64),
    source_session_id: 'session-a',
    collector_version: '0.9.0',
    host_version: null,
    observed_at: new Date().toISOString(),
    reason: 'other',
    last_active_host_prompt_id: null,
  };
  const id = enqueueHostObservation('session-a', 'session_end', payload);
  assert.equal(typeof id, 'string');
  assert.equal(outbox.listPending().length, 1);

  state.markKindUnsupported('session-a', 'session_end');
  const secondPayload = { ...payload, adapter_event_id: 'b'.repeat(64) };
  assert.equal(enqueueHostObservation('session-a', 'session_end', secondPayload), null);
  assert.equal(outbox.listPending().length, 1);
});

test('collectAndEnqueueHostObservations reads a fixture transcript span and enqueues each kind it finds', () => {
  const outbox = require('../lib/response-outbox');
  const { collectAndEnqueueHostObservations } = require('../lib/host-observation-collection');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-host-observation-transcript-'));
  const transcriptPath = path.join(home, 'transcript.jsonl');
  const hostPromptId = 'host-prompt-1';
  try {
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({
        type: 'attachment',
        uuid: 'queued-row',
        parentUuid: 'parent-row',
        timestamp: '2026-09-15T00:00:01.000Z',
        attachment: {
          type: 'queued_command', prompt: 'queued instruction', source_uuid: 'source-1', origin: { kind: 'human' }, isMeta: false, commandMode: 'default',
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'marker-row',
        promptId: hostPromptId,
        timestamp: '2026-09-15T00:00:02.000Z',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      }),
      '',
    ].join('\n'));

    const result = collectAndEnqueueHostObservations({
      sessionId: 'session-a',
      transcriptPath,
      byteOffset: 0,
      hostPromptId,
      clientEventId: 'client-event-1',
      promptOutboxId: 'prompt-client-event-1',
      collectorVersion: '0.9.0',
      observedAt: '2026-09-15T00:00:03.000Z',
    });
    assert.equal(result.ok, true);
    assert.equal(result.enqueuedIds.length, 2);

    const pending = outbox.listPending();
    const queued = pending.find((entry) => entry.kind === 'queued_input');
    const marker = pending.find((entry) => entry.kind === 'turn_interrupt_marker');
    const origin = pending.find((entry) => entry.kind === 'prompt_input_origin');
    assert.ok(queued, 'expected a queued_input entry');
    assert.ok(marker, 'expected a turn_interrupt_marker entry');
    assert.deepEqual(result.enqueuedIds.sort(), [queued.id, marker.id].sort());
    // No hook source and no candidate input-origin row (the user row here is
    // an interrupt marker, not a promptSource-bearing row) means no basis:
    // input-origin must not be fabricated.
    assert.equal(origin, undefined);
    assert.equal(queued.payload.attached_under_host_prompt_id, hostPromptId);
    assert.equal(queued.dependsOn, undefined);
    assert.equal(marker.payload.marker_kind, 'user');
    assert.equal(marker.dependsOn, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collectAndEnqueueHostObservations couples input-origin to the prompt outbox entry via dependsOn', () => {
  const outbox = require('../lib/response-outbox');
  const state = require('../lib/host-observation-state');
  const { collectAndEnqueueHostObservations } = require('../lib/host-observation-collection');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-host-observation-origin-'));
  const transcriptPath = path.join(home, 'transcript.jsonl');
  const hostPromptId = 'host-prompt-2';
  try {
    fs.writeFileSync(transcriptPath, '');
    state.recordHookSource('session-a', hostPromptId, 'user');

    const result = collectAndEnqueueHostObservations({
      sessionId: 'session-a',
      transcriptPath,
      byteOffset: 0,
      hostPromptId,
      clientEventId: 'client-event-2',
      promptOutboxId: 'prompt-client-event-2',
      collectorVersion: '0.9.0',
      observedAt: '2026-09-15T00:00:04.000Z',
    });
    assert.equal(result.ok, true);

    const origin = outbox.listPending().find((entry) => entry.kind === 'prompt_input_origin');
    assert.ok(origin);
    assert.equal(origin.dependsOn, 'prompt-client-event-2');
    assert.equal(origin.payload.hook_source, 'user');
    assert.equal(origin.payload.observation_basis, 'hook_field');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an unreadable transcript records a gap and enqueues nothing', () => {
  const outbox = require('../lib/response-outbox');
  const { collectAndEnqueueHostObservations } = require('../lib/host-observation-collection');
  const result = collectAndEnqueueHostObservations({
    sessionId: 'session-a',
    transcriptPath: '/nonexistent/prism-transcript.jsonl',
    byteOffset: 0,
    hostPromptId: 'host-prompt-3',
    clientEventId: 'client-event-3',
    promptOutboxId: 'prompt-client-event-3',
    collectorVersion: '0.9.0',
    observedAt: '2026-09-15T00:00:05.000Z',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'transcript_unreadable');
  assert.equal(outbox.listPending().length, 0);
  const terminalDir = outbox.getTerminalRejectedDir();
  const terminalFiles = fs.existsSync(terminalDir) ? fs.readdirSync(terminalDir) : [];
  assert.ok(terminalFiles.length >= 1);
});

test('enqueueStopContext allocates a per host_prompt_id 0-based ordinal', () => {
  const outbox = require('../lib/response-outbox');
  const { enqueueStopContext } = require('../lib/host-observation-collection');
  const data = { stop_hook_active: true, background_tasks: [{}], session_crons: [] };
  assert.equal(typeof enqueueStopContext({
    sessionId: 'session-a', data, hostPromptId: 'prompt-1', collectorVersion: '0.9.0', hostVersion: null, observedAt: '2026-09-15T00:00:06.000Z',
  }), 'string');
  assert.equal(typeof enqueueStopContext({
    sessionId: 'session-a', data, hostPromptId: 'prompt-1', collectorVersion: '0.9.0', hostVersion: null, observedAt: '2026-09-15T00:00:07.000Z',
  }), 'string');
  const stopContexts = outbox.listPending().filter((entry) => entry.kind === 'stop_context');
  assert.equal(stopContexts.length, 2);
  assert.deepEqual(stopContexts.map((entry) => entry.payload.stop_ordinal).sort(), [0, 1]);
  assert.equal(stopContexts[0].payload.stop_hook_active, true);
  assert.equal(stopContexts[0].payload.background_task_count, 1);
});

test('enqueueSessionEnd builds a session_end payload from the SessionEnd hook input', () => {
  const outbox = require('../lib/response-outbox');
  const { enqueueSessionEnd } = require('../lib/host-observation-collection');
  assert.equal(typeof enqueueSessionEnd({
    sessionId: 'session-a',
    data: { reason: 'clear' },
    lastActiveHostPromptId: 'prompt-1',
    collectorVersion: '0.9.0',
    hostVersion: '2.1.180',
    observedAt: '2026-09-15T00:00:08.000Z',
  }), 'string');
  const [entry] = outbox.listPending();
  assert.equal(entry.kind, 'session_end');
  assert.equal(entry.payload.reason, 'clear');
  assert.equal(entry.payload.last_active_host_prompt_id, 'prompt-1');
  assert.equal(entry.payload.host_version, '2.1.180');
});
