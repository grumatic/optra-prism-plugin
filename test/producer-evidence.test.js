const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  EVIDENCE_NAMESPACE,
  buildSendMessageOccurrence,
  observeUserPromptSubmit,
} = require('../lib/producer-evidence');
const { isExactPromptEvidenceAck } = require('../lib/outbox-delivery');

test('UserPromptSubmit evidence remains UNKNOWN for ordinary and literal agent-message bodies', () => {
  for (const prompt of ['write a migration', '<agent-message>user typed this literally</agent-message>']) {
    const evidence = observeUserPromptSubmit({
      session_id: 'session-a',
      prompt_id: 'prompt-a',
      prompt,
      agent_id: 'execution-context',
    }, '2026-08-26T00:00:00.000Z');
    assert.equal(evidence.namespace, EVIDENCE_NAMESPACE);
    assert.equal(evidence.evidence_type, 'user_prompt_submit_received');
    assert.equal(evidence.producer_kind, 'UNKNOWN');
    assert.equal(evidence.hook_event_name, 'UserPromptSubmit');
    assert.equal(evidence.agent_id, 'execution-context');
  }
});

test('successful SendMessage occurrence has stable identity and no raw message body', () => {
  const input = {
    hook_event_name: 'PostToolUse',
    tool_name: 'SendMessage',
    session_id: 'source-session',
    prompt_id: 'host-prompt',
    tool_use_id: 'tool-use',
    agent_id: 'agent-context',
    tool_input: { recipient: 'teammate-a', message: 'raw secret message body' },
    tool_response: { success: true, delivered: true },
  };
  const first = buildSendMessageOccurrence(input, '2026-08-26T00:00:00.000Z');
  const second = buildSendMessageOccurrence(input, '2026-08-26T01:00:00.000Z');
  assert.equal(first.ok, true);
  assert.equal(first.payload.client_event_id, second.payload.client_event_id);
  assert.equal(first.payload.client_event_id, crypto.createHash('sha256')
    .update(Buffer.concat([
      Buffer.from('prism.prompt-evidence.client-event-id.v1\0', 'ascii'),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 14]), Buffer.from('source-session'),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 8]), Buffer.from('tool-use'),
    ])).digest('hex'));
  const evidence = first.payload.producer_evidence;
  assert.equal(evidence.producer_kind, 'AGENT');
  assert.equal(first.payload.host_prompt_id, 'host-prompt');
  assert.equal(first.payload.message_byte_count, Buffer.byteLength(input.tool_input.message, 'utf8'));
  assert.equal(first.payload.message_sha256, crypto.createHash('sha256').update(input.tool_input.message, 'utf8').digest('hex'));
  assert.equal(first.payload.host_success.success, true);
  assert.equal(JSON.stringify(first.payload).includes(input.tool_input.message), false);
});

test('native SendMessage {to, summary, message} host input captures its opaque recipient without storing summary', () => {
  const summary = 'routing-only host summary';
  const occurrence = buildSendMessageOccurrence({
    hook_event_name: 'PostToolUse', tool_name: 'SendMessage', session_id: 'session', prompt_id: 'prompt', tool_use_id: 'tool',
    tool_input: { to: 'lead-agent', summary, message: 'body' }, tool_response: { success: true },
  }, '2026-08-26T00:00:00.000Z');
  assert.equal(occurrence.ok, true);
  assert.equal(occurrence.payload.recipient, 'lead-agent');
  assert.equal(JSON.stringify(occurrence.payload).includes(summary), false);
});

test('deterministic SendMessage identity uses the shared length-prefixed golden vectors', () => {
  const { deterministicEvidenceId } = require('../lib/producer-evidence');
  assert.equal(deterministicEvidenceId('session', 'tool'), 'f4d0f4856546a12ea08c2e15a0fc518e48929353345d412e81921c54b2647e94');
  assert.equal(deterministicEvidenceId('세션', 'tool:1'), 'd15add3dcee2691656f6fdc3350672ed3167bf11e05bf76d0d3638e88b960e03');
});

test('failed/non-SendMessage hook never creates an occurrence and incomplete successful input is a gap', () => {
  assert.deepEqual(buildSendMessageOccurrence({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }), {
    ok: false,
    reason: 'not_successful_send_message_hook',
  });
  assert.deepEqual(buildSendMessageOccurrence({
    hook_event_name: 'PostToolUse', tool_name: 'SendMessage', session_id: 's', tool_use_id: 't', tool_input: { message: 'm' },
  }), {
    ok: false,
    reason: 'invalid_send_message_host_input',
  });
});

test('provided oversized agent context is rejected as a deterministic send gap, not silently omitted', () => {
  const result = buildSendMessageOccurrence({
    hook_event_name: 'PostToolUse', tool_name: 'SendMessage', session_id: 's', prompt_id: 'p', tool_use_id: 't',
    agent_id: 'x'.repeat(1025), tool_input: { recipient: 'peer', message: 'm' }, tool_response: {},
  });
  assert.deepEqual(result, { ok: false, reason: 'prompt_evidence_exceeds_limit' });
});

test('provided invalid receive agent context keeps legacy prompt delivery and records a bounded gap', () => {
  const root = path.resolve(__dirname, '..');
  const handler = path.join(root, 'hooks', 'scripts', 'submit-handler.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-receive-context-gap-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-receive-context-home-'));
  try {
    fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
    fs.writeFileSync(path.join(home, '.prism', 'config.json'), JSON.stringify({ apiKey: 'key', ingest_url: 'http://127.0.0.1:9' }));
    const result = spawnSync(process.execPath, [handler], {
      cwd: root,
      input: JSON.stringify({ session_id: 'session', prompt_id: 'prompt', prompt: 'body', agent_type: 'x'.repeat(1025) }),
      encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const outboxDir = path.join(dataDir, 'runtime', 'outbox');
    const [file] = fs.readdirSync(outboxDir).filter((name) => name.endsWith('.json'));
    const pending = JSON.parse(fs.readFileSync(path.join(outboxDir, file), 'utf8'));
    assert.equal(pending.kind, 'prompt');
    assert.equal(Object.hasOwn(pending.payload.metadata, 'producer_evidence'), false);
    assert.equal(fs.readdirSync(path.join(dataDir, 'runtime', 'outbox-terminal-rejected'))
      .filter((name) => name.endsWith('.json'))
      .some((name) => fs.readFileSync(path.join(dataDir, 'runtime', 'outbox-terminal-rejected', name), 'utf8').includes('prompt_producer_evidence_exceeds_limit')), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('PostToolUseFailure SendMessage is not a successful occurrence', () => {
  assert.equal(buildSendMessageOccurrence({
    hook_event_name: 'PostToolUseFailure', tool_name: 'SendMessage', session_id: 's', prompt_id: 'p', tool_use_id: 't',
  }).ok, false);
});

test('repeated hook execution preserves the first observed evidence body under one durable intent', () => {
  const root = path.resolve(__dirname, '..');
  const handler = path.join(root, 'hooks', 'scripts', 'send-message-evidence-handler.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-evidence-repeat-'));
  const input = {
    hook_event_name: 'PostToolUse', tool_name: 'SendMessage', session_id: 'session', prompt_id: 'prompt', tool_use_id: 'tool',
    tool_input: { recipient: 'peer', message: 'body' }, tool_response: { success: true },
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      const result = spawnSync(process.execPath, [handler], {
        cwd: root, input: JSON.stringify(input), encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, HOME: dataDir },
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const outboxDir = path.join(dataDir, 'runtime', 'outbox');
    const files = fs.readdirSync(outboxDir).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outboxDir, files[0]), 'utf8')).kind, 'prompt_evidence');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('prompt evidence requires an exact bounded ACK with its client event identity', () => {
  const id = 'a'.repeat(64);
  assert.equal(isExactPromptEvidenceAck({ status: 200, mediaType: 'application/json', body: JSON.stringify({
    ack_version: 1,
    client_event_id: id,
    occurrence_id: 'occurrence-a',
    status: 'accepted',
  }) }, id), true);
  assert.equal(isExactPromptEvidenceAck({ status: 202, mediaType: 'application/json', body: JSON.stringify({
    ack_version: 1, client_event_id: 'b'.repeat(64), occurrence_id: 'occurrence-a', status: 'accepted',
  }) }, id), false);
  assert.equal(isExactPromptEvidenceAck({ status: 200, mediaType: 'text/plain', body: 'x' }, id), false);
  assert.equal(isExactPromptEvidenceAck({ status: 200, mediaType: 'application/json', body: 'x'.repeat(4097) }, id), false);
});
