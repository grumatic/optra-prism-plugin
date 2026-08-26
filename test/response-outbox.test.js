const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const outbox = require('../lib/response-outbox');
const session = require('../lib/session');

const dirs = [];
let previousDataDir;
let previousHome;

function clearRuntimeConfigModules() {
  for (const modulePath of ['../lib/env', '../lib/config', '../lib/binding']) {
    delete require.cache[require.resolve(modulePath)];
  }
}

beforeEach(() => {
  previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  previousHome = process.env.HOME;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-response-outbox-data-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-response-outbox-home-'));
  dirs.push(dataDir, homeDir);
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  process.env.HOME = homeDir;
  clearRuntimeConfigModules();
});

afterEach(() => {
  clearRuntimeConfigModules();
  if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function responseEntry(id, dependsOn) {
  return {
    id,
    kind: 'response',
    ...(dependsOn ? { dependsOn } : {}),
    payload: { response_text: id },
  };
}
function promptEntry(id) {
  return {
    id,
    kind: 'prompt',
    payload: { prompt_text: id },
  };
}
function entryFile(id) {
  return path.join(
    outbox.getOutboxDir(),
    `${crypto.createHash('sha256').update(id).digest('hex')}.json`,
  );
}

function fencedResponse(sessionId, epoch, clientEventId, submitPromptId, serverPromptId, createdAt) {
  const id = crypto.createHash('sha256')
    .update(`${sessionId}\n${clientEventId}\n${submitPromptId}`)
    .digest('hex');
  return {
    id,
    kind: 'response',
    createdAt,
    payload: {
      tool_session_id: sessionId,
      client_event_id: clientEventId,
      host_prompt_id: submitPromptId,
      prompt_id: serverPromptId,
      response_operation_id: id,
      response_text: '',
    },
    deliveryFence: {
      sessionId,
      epoch,
      clientEventId,
      submitPromptId,
      serverPromptId,
    },
  };
}

test('terminal retention policy constants remain bounded', () => {
  assert.equal(outbox.MAX_TERMINAL_REJECTED_ENTRIES, 32);
  assert.equal(outbox.MAX_TERMINAL_REJECTED_BYTES, 64 * 1024 * 1024);
  // MAX_WIRE_BYTES (see lib/body-clamp.js) + 128 KiB envelope margin.
  assert.equal(outbox.MAX_ENTRY_BYTES, Math.ceil((6 * 1024 * 1024 - 128 * 1024) / 2) + 128 * 1024);
  assert.equal(outbox.MAX_ENTRY_BYTES, 3211264);
  assert.equal(outbox.MAX_PENDING_ENTRIES, 512);
  assert.equal(outbox.MAX_PENDING_BYTES, 128 * 1024 * 1024);
  assert.equal(outbox.TERMINAL_REJECTED_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(outbox.ORPHAN_TEMP_AGE_MS, 5 * 60 * 1000);
});

test('failed delivery remains queued and is redelivered by the next drain', async () => {
  assert.equal(outbox.enqueue(responseEntry('response-retry')), true);
  const first = await outbox.drain(async () => ({ status: 503, body: 'unavailable' }));
  assert.deepEqual(first.map(({ id, acked }) => ({ id, acked })), [{ id: 'response-retry', acked: false }]);
  assert.equal(outbox.listPending().length, 1);

  let sends = 0;
  const second = await outbox.drain(async () => {
    sends += 1;
    return { status: 202, body: 'accepted' };
  });
  assert.equal(sends, 1);
  assert.deepEqual(second.map(({ id, acked }) => ({ id, acked })), [{ id: 'response-retry', acked: true }]);
  assert.deepEqual(outbox.listPending(), []);
});

test('response delivery stays ahead of prompts and evidence, and evidence is last', async () => {
  assert.equal(outbox.enqueue({ id: 'evidence', kind: 'prompt_evidence', payload: { client_event_id: 'a'.repeat(64), producer_evidence: {} } }), true);
  assert.equal(outbox.enqueue(promptEntry('prompt')), true);
  assert.equal(outbox.enqueue(responseEntry('response')), true);
  const delivered = [];
  await outbox.drain(async (entry) => {
    delivered.push(entry.id);
    return { status: 202, body: 'accepted' };
  }, { prioritizeIds: ['evidence'] });
  assert.deepEqual(delivered, ['response', 'prompt', 'evidence']);
});

test('evidence survives a transient failure and an unrecognized success ACK, then replays after restart semantics', async () => {
  const evidence = { id: 'evidence-replay', kind: 'prompt_evidence', payload: { client_event_id: 'b'.repeat(64), producer_evidence: {} } };
  assert.equal(outbox.enqueue(evidence), true);
  await outbox.drain(async () => ({ status: 503, body: 'unavailable' }));
  assert.equal(outbox.listPending().length, 1);
  // A 2xx response alone must not delete evidence; the dedicated delivery
  // adapter sets ack only after the exact server receipt is validated.
  await outbox.drain(async () => ({ status: 202, body: '{}', ack: false }));
  assert.equal(outbox.listPending().length, 1);
  const replay = await outbox.drain(async () => ({ status: 202, body: '{}', ack: true }));
  assert.equal(replay[0].acked, true);
  assert.deepEqual(outbox.listPending(), []);
});

test('evidence capacity eviction writes a terminal tombstone before removing the pending intent', () => {
  const evidence = { id: 'evidence-evicted', kind: 'prompt_evidence', payload: { client_event_id: 'c'.repeat(64), producer_evidence: {} } };
  assert.equal(outbox.enqueue(evidence), true);
  for (let index = 0; index < outbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(outbox.enqueue(promptEntry(`prompt-for-evidence-eviction-${index}`)), true);
  }
  assert.equal(outbox.listPending().some((entry) => entry.id === evidence.id), false);
  const terminalFile = path.join(outbox.getTerminalRejectedDir(), `${crypto.createHash('sha256').update(evidence.id).digest('hex')}.json`);
  assert.equal(JSON.parse(fs.readFileSync(terminalFile, 'utf8')).terminalReason, 'outbox_evicted_capacity');
});

test('producer evidence terminal codes distinguish semantic and raw body limits', () => {
  for (const [status, code] of [
    [413, 'prompt_evidence_exceeds_limit'],
    [413, 'prompt_evidence_request_too_large'],
    [413, 'prompt_producer_evidence_exceeds_limit'],
    [400, 'prompt_producer_evidence_identity_mismatch'],
  ]) {
    const body = JSON.stringify({ error: { code } });
    assert.equal(outbox.terminalRejectionCode({ status, mediaType: 'application/json', body }), code);
  }
});

test('a 413 evidence size rejection tombstones the actual server code and removes the pending intent', async () => {
  const intent = { id: 'evidence-size-terminal', kind: 'prompt_evidence', payload: { client_event_id: 'd'.repeat(64), producer_evidence: {} } };
  assert.equal(outbox.enqueue(intent), true);
  const body = JSON.stringify({ error: { code: 'prompt_evidence_exceeds_limit' } });
  const [outcome] = await outbox.drain(async () => ({ status: 413, mediaType: 'application/json', body }));
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.terminalReason, 'prompt_evidence_exceeds_limit');
  assert.deepEqual(outbox.listPending(), []);
});

test('an entry that keeps failing is demoted behind a fresher one instead of head-of-line-blocking it forever', async () => {
  // Oldest by createdAt, so a pure age-ordered schedule would always attempt
  // this one first, ahead of anything enqueued afterward.
  assert.equal(outbox.enqueue({
    ...responseEntry('perpetually-failing'),
    createdAt: new Date(0).toISOString(),
  }), true);

  // Fail it enough times to accumulate a durable attempt count.
  for (let i = 0; i < 3; i += 1) {
    await outbox.drain(async () => ({ status: 503, body: 'unavailable' }));
  }
  const [failing] = outbox.listPending();
  assert.equal(failing.id, 'perpetually-failing');
  assert.equal(failing.deliveryAttempts, 3);

  assert.equal(outbox.enqueue({
    ...responseEntry('fresh-after-failures'),
    createdAt: new Date(1000).toISOString(),
  }), true);

  // With limit: 1, an age-only schedule would retry the perpetually-failing
  // entry (older createdAt) again and starve the fresh one. Demotion by
  // attempt count means the fresh entry — 0 attempts vs. 3 — goes first.
  const attempted = [];
  const outcomes = await outbox.drain(async (entry) => {
    attempted.push(entry.id);
    return entry.id === 'fresh-after-failures'
      ? { status: 202, body: 'accepted' }
      : { status: 503, body: 'unavailable' };
  }, { limit: 1 });

  assert.deepEqual(attempted, ['fresh-after-failures']);
  assert.equal(outcomes[0].acked, true);
  assert.deepEqual(outbox.listPending().map((entry) => entry.id), ['perpetually-failing']);
});

test('eviction order is independent of delivery-attempt mtime bumps: a chronically-failing old entry is evicted before fresh unattempted prompts', async () => {
  assert.equal(outbox.enqueue({
    ...promptEntry('old-failing-prompt'),
    createdAt: new Date(0).toISOString(),
  }), true);

  // Each failed attempt rewrites the file (bumpDeliveryAttempts), which
  // refreshes its mtime well past every entry enqueued afterward. Eviction
  // must still treat this as the OLDEST entry by createdAt, not the newest
  // by mtime.
  for (let i = 0; i < 5; i += 1) {
    await outbox.drain(async () => ({ status: 503, body: 'unavailable' }));
  }
  const [failing] = outbox.listPending();
  assert.equal(failing.id, 'old-failing-prompt');
  assert.equal(failing.deliveryAttempts, 5);

  for (let index = 0; index < outbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(outbox.enqueue({
      ...promptEntry(`fresh-prompt-${index}`),
      createdAt: new Date((index + 1) * 1000).toISOString(),
    }), true);
  }

  const pending = outbox.listPending();
  assert.equal(pending.length, outbox.MAX_PENDING_ENTRIES);
  assert.equal(pending.some((entry) => entry.id === 'old-failing-prompt'), false);
  assert.equal(pending.some((entry) => entry.id === 'fresh-prompt-0'), true);
  assert.equal(pending.some((entry) => entry.id === `fresh-prompt-${outbox.MAX_PENDING_ENTRIES - 1}`), true);
});

test('a corrupt (unparseable) dependency file does not permanently block its response', async () => {
  const prompt = promptEntry('corrupt-dependency-prompt');
  assert.equal(outbox.enqueue(prompt), true);
  // Corrupt the durable prompt file in place: it exists on disk but fails
  // JSON.parse, the way disk corruption or a partial write would leave it.
  fs.writeFileSync(entryFile(prompt.id), 'not valid json{{{');

  const response = { ...responseEntry('response-with-corrupt-dependency'), dependsOn: prompt.id };
  assert.equal(outbox.enqueue(response), true);

  const outcomes = await outbox.drain(async () => ({ status: 202, body: 'accepted' }));
  const responseOutcome = outcomes.find((outcome) => outcome.id === response.id);
  assert.ok(responseOutcome, 'response entry was attempted despite its corrupt dependency');
  assert.equal(responseOutcome.acked, true);
  assert.deepEqual(outbox.listPending().map((entry) => entry.id), []);
});

test('duplicate idempotent delivery is acknowledged without duplicate local state', async () => {
  const intent = responseEntry('response-idempotent');
  const deliveries = [];
  assert.equal(outbox.enqueue(intent), true);
  await outbox.drain(async (entry) => {
    deliveries.push({ id: entry.id, body: 'created' });
    return { status: 202, body: 'created' };
  });

  assert.equal(outbox.enqueue(intent), true);
  const replay = await outbox.drain(async (entry) => {
    deliveries.push({ id: entry.id, body: 'idempotent-noop' });
    return { status: 202, body: 'idempotent-noop' };
  });
  assert.deepEqual(deliveries, [
    { id: 'response-idempotent', body: 'created' },
    { id: 'response-idempotent', body: 'idempotent-noop' },
  ]);
  assert.equal(replay[0].acked, true);
  assert.deepEqual(outbox.listPending(), []);
});

test('every machine-coded admission rejection is terminal and unknown codes are not', () => {
  for (const code of [
    'invalid_host_prompt_id',
    'unrecognized_source',
    'empty_prompt_text',
    'prompt_body_exceeds_limit',
    'response_body_exceeds_limit',
  ]) {
    const body = JSON.stringify({ error: { code } });
    assert.equal(outbox.terminalRejectionCode({
      status: 400,
      mediaType: 'application/json',
      body,
      bodyBytes: Buffer.byteLength(body),
      bodyTruncated: false,
    }), code);
  }
  // The set is closed: a well-shaped envelope carrying an unregistered code
  // stays retryable rather than silently becoming terminal.
  const unknown = JSON.stringify({ error: { code: 'some_future_code' } });
  assert.equal(outbox.terminalRejectionCode({
    status: 400,
    mediaType: 'application/json',
    body: unknown,
    bodyBytes: Buffer.byteLength(unknown),
    bodyTruncated: false,
  }), null);
});

test('an HTTP 413 is terminal only for ingest\'s exact fixed PayloadTooLarge shape', async () => {
  assert.equal(outbox.isTerminalHttp413({
    status: 413,
    mediaType: 'text/plain',
    body: 'Request body too large',
    bodyTruncated: false,
  }), true);
  for (const result of [
    // Status-only match with a different body is not ingest's fixed shape.
    { status: 413, body: '' },
    { status: 413, mediaType: 'text/plain', body: 'Payload Too Large' },
    // A proxy-style 413 in front of an old pre-contract server: wrong media
    // type (e.g. an nginx/CDN HTML error page) must never settle terminal.
    { status: 413, mediaType: 'text/html', body: '<html><body>413 Request Entity Too Large</body></html>' },
    // A misconfigured ingress emitting the right words but truncated or with
    // extra content is not the exact fixed string either.
    { status: 413, mediaType: 'text/plain', body: 'Request body too large\n' },
    { status: 413, mediaType: 'text/plain', body: 'Request body too larg' },
    { status: 413, mediaType: 'text/plain', body: 'Request body too large', bodyTruncated: true },
    { status: 400, mediaType: 'application/json', body: JSON.stringify({ error: { code: 'prompt_body_exceeds_limit' } }) },
    { status: 200, body: '' },
    undefined,
    null,
  ]) assert.notEqual(outbox.isTerminalHttp413(result), true);

  const terminal = responseEntry('terminal-http-413');
  assert.equal(outbox.enqueue(terminal), true);
  const [terminalOutcome] = await outbox.drain(async () => ({
    status: 413,
    mediaType: 'text/plain',
    body: 'Request body too large',
    bodyTruncated: false,
  }));
  assert.equal(terminalOutcome.terminal, true);
  assert.equal(terminalOutcome.terminalReason, 'http_413');
  assert.equal(terminalOutcome.primaryRemoved, true);
  assert.deepEqual(outbox.listPending(), []);
  assert.equal(outbox.isTerminalRejected(terminal.id), true);

  // A proxy-style (or misordered-deploy) 413 stays retryable — the entry
  // survives in the pending spool for the next drain rather than being lost.
  const retryable = responseEntry('retryable-html-413');
  assert.equal(outbox.enqueue(retryable), true);
  const [retryableOutcome] = await outbox.drain(async () => ({
    status: 413,
    mediaType: 'text/html',
    body: '<html><body>413 Request Entity Too Large</body></html>',
  }));
  assert.notEqual(retryableOutcome.terminal, true);
  assert.equal(retryableOutcome.acked, false);
  assert.deepEqual(outbox.listPending().map((entry) => entry.id), [retryable.id]);
  assert.equal(outbox.isTerminalRejected(retryable.id), false);
});

test('terminal rejection requires the exact bounded JSON envelope and isolates the original intent', async () => {
  const body = JSON.stringify({ error: { code: 'invalid_host_prompt_id' } });
  assert.equal(outbox.isTerminalInvalidHostPrompt({
    status: 400,
    mediaType: 'application/json',
    body,
    bodyBytes: Buffer.byteLength(body),
    bodyTruncated: false,
  }), true);
  for (const result of [
    { status: 400, mediaType: 'text/plain', body },
    { status: 400, mediaType: 'application/json', body: JSON.stringify({ error: { code: 'other' } }) },
    { status: 400, mediaType: 'application/json', body: '{broken' },
    { status: 400, mediaType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_host_prompt_id' }, detail: 'extra' }) },
    { status: 400, mediaType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_host_prompt_id', message: 'extra' } }) },
    { status: 400, mediaType: 'application/json', body: JSON.stringify({ code: 'invalid_host_prompt_id' }) },
    { status: 400, mediaType: 'application/json', body, bodyBytes: 4097 },
    { status: 400, mediaType: 'application/json', body, bodyTruncated: true },
    ...[401, 404, 409, 413, 429, 499, 500, 503].map((status) => ({ status, mediaType: 'application/json', body })),
  ]) assert.notEqual(outbox.isTerminalInvalidHostPrompt(result), true);

  const intent = responseEntry('terminal-invalid-host');
  assert.equal(outbox.enqueue(intent), true);
  const [outcome] = await outbox.drain(async () => ({
    status: 400,
    mediaType: 'application/json',
    body,
    bodyBytes: Buffer.byteLength(body),
    bodyTruncated: false,
  }));
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.primaryRemoved, true);
  assert.deepEqual(outbox.listPending(), []);
  assert.equal(outbox.isTerminalRejected(intent.id), true);
  const [stored] = fs.readdirSync(outbox.getTerminalRejectedDir())
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(outbox.getTerminalRejectedDir(), name), 'utf8')));
  assert.deepEqual(stored, { ...intent, createdAt: stored.createdAt, terminalReason: 'invalid_host_prompt_id' });
  assert.equal(Object.hasOwn(stored, 'body'), false);
});

test('missing terminal media type and sender errors remain pending for retry', async () => {
  const intent = responseEntry('retry-missing-media-type');
  assert.equal(outbox.enqueue(intent), true);
  const body = JSON.stringify({ error: { code: 'invalid_host_prompt_id' } });
  const [missingMediaType] = await outbox.drain(async () => ({ status: 400, body }));
  assert.notEqual(missingMediaType.terminal, true);
  assert.equal(missingMediaType.acked, false);
  assert.equal(outbox.listPending().length, 1);
  const [timedOut] = await outbox.drain(async () => { throw new Error('timeout'); });
  assert.equal(timedOut.acked, false);
  assert.equal(outbox.listPending().length, 1);
  const [recovered] = await outbox.drain(async () => ({ status: 202 }));
  assert.equal(recovered.acked, true);
  assert.deepEqual(outbox.listPending(), []);
});

test('outbox entry serialization accepts exactly MAX_ENTRY_BYTES and rejects one additional byte', () => {
  const base = {
    ...responseEntry('serialized-boundary'),
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: { response_text: '' },
  };
  const exact = {
    ...base,
    payload: { response_text: 'x'.repeat(outbox.MAX_ENTRY_BYTES - outbox.serializedEntryBytes(base)) },
  };
  assert.equal(outbox.serializedEntryBytes(exact), outbox.MAX_ENTRY_BYTES);
  assert.equal(outbox.enqueueDetailed(exact).outcome, 'created');
  assert.equal(outbox.enqueueDetailed({
    ...exact,
    id: 'serialized-boundary-over',
    payload: { response_text: `${exact.payload.response_text}x` },
  }).outcome, 'oversized');
});

test('a real clamped body plus a maximal realistic envelope fits MAX_ENTRY_BYTES (regression guard on the margin)', () => {
  const { MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES, clampToWireLimit } = require('../lib/body-clamp');
  const sessionId = 's'.repeat(1024); // validSessionId's max (lib/session.js)
  const submitPromptId = 'h'.repeat(1024); // MAX_HOST_PROMPT_ID_BYTES (lib/host-prompt-id.js)
  const clientEventId = '5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f';
  const serverPromptId = '11111111-1111-4111-8111-111111111111';
  const epoch = Number.MAX_SAFE_INTEGER;

  const buildEntry = (rawText) => {
    const clamped = clampToWireLimit(rawText, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
    const entry = fencedResponse(sessionId, epoch, clientEventId, submitPromptId, serverPromptId, new Date().toISOString());
    entry.payload.response_text = clamped;
    return { entry, clamped };
  };

  // Plain content: the decoded bound binds, so the escaped field lands near
  // MAX_PROMPT_BODY_BYTES (2 MiB), not the larger MAX_WIRE_BYTES.
  const plain = buildEntry('x'.repeat(MAX_WIRE_BYTES));
  assert.equal(outbox.enqueueDetailed(plain.entry).outcome, 'created');
  assert.equal(outbox.markAcked(plain.entry.id), true);

  // Escape-heavy content: the wire bound binds, so the escaped field can
  // reach the full MAX_WIRE_BYTES (~2.9375 MiB) — this is the case that
  // actually exercises the MAX_ENTRY_BYTES margin.
  const escapeHeavy = buildEntry('"\\\n\t\r'.repeat(Math.ceil(MAX_WIRE_BYTES / 6)));
  assert.equal(Buffer.byteLength(JSON.stringify(escapeHeavy.clamped), 'utf8') > MAX_PROMPT_BODY_BYTES, true);
  assert.equal(outbox.enqueueDetailed(escapeHeavy.entry).outcome, 'created');
  assert.equal(outbox.markAcked(escapeHeavy.entry.id), true);
});

test('terminal retention evicts the oldest filename tie and reaps expired entries and temps', async () => {
  const terminal = async (id) => {
    assert.equal(outbox.enqueue(responseEntry(id)), true);
    const [outcome] = await outbox.drain(async () => ({
      status: 400,
      mediaType: 'application/json',
      body: JSON.stringify({ error: { code: 'invalid_host_prompt_id' } }),
    }));
    assert.equal(outcome.terminal, true);
  };
  for (let index = 0; index < outbox.MAX_TERMINAL_REJECTED_ENTRIES; index += 1) {
    await terminal(`terminal-cap-${index}`);
  }
  const terminalDir = outbox.getTerminalRejectedDir();
  const sameTime = new Date(Date.now() - 1_000);
  const before = fs.readdirSync(terminalDir).filter((name) => name.endsWith('.json')).sort();
  for (const name of before) fs.utimesSync(path.join(terminalDir, name), sameTime, sameTime);
  await terminal('terminal-cap-next');
  const after = fs.readdirSync(terminalDir).filter((name) => name.endsWith('.json')).sort();
  assert.equal(after.length, outbox.MAX_TERMINAL_REJECTED_ENTRIES);
  assert.equal(after.includes(before[0]), false);

  const stale = path.join(terminalDir, after[0]);
  const expired = new Date(Date.now() - outbox.TERMINAL_REJECTED_RETENTION_MS - 1_000);
  fs.utimesSync(stale, expired, expired);
  const orphan = path.join(terminalDir, '.00000000-0000-4000-8000-000000000000.tmp');
  fs.writeFileSync(orphan, 'orphan');
  fs.utimesSync(orphan, new Date(Date.now() - outbox.ORPHAN_TEMP_AGE_MS - 1_000), new Date(Date.now() - outbox.ORPHAN_TEMP_AGE_MS - 1_000));
  await terminal('terminal-reap-trigger');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(orphan), false);
});

test('a verified terminal tombstone preserves the primary on delete failure and prevents a resend after restart', async () => {
  const intent = responseEntry('terminal-delete-retry');
  assert.equal(outbox.enqueue(intent), true);
  const originalUnlinkSync = fs.unlinkSync;
  const primary = entryFile(intent.id);
  fs.unlinkSync = function failPrimaryDelete(file, ...args) {
    if (file === primary) {
      const error = new Error('injected delete failure');
      error.code = 'EIO';
      throw error;
    }
    return originalUnlinkSync.call(this, file, ...args);
  };
  try {
    const [outcome] = await outbox.drain(async () => ({
      status: 400,
      mediaType: 'application/json',
      body: JSON.stringify({ error: { code: 'invalid_host_prompt_id' } }),
    }));
    assert.equal(outcome.terminal, true);
    assert.equal(outcome.primaryRemoved, false);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(outbox.listPending().length, 1);
  let sends = 0;
  const [restarted] = await outbox.drain(async () => {
    sends += 1;
    return { status: 202 };
  });
  assert.equal(sends, 0);
  assert.equal(restarted.terminal, true);
  assert.equal(restarted.primaryRemoved, true);
  assert.deepEqual(outbox.listPending(), []);
});

test('terminal final publication failure leaves the primary pending without hot deletion', async () => {
  const intent = responseEntry('terminal-link-failure');
  assert.equal(outbox.enqueue(intent), true);
  const originalLinkSync = fs.linkSync;
  const terminalDir = outbox.getTerminalRejectedDir();
  fs.linkSync = function failTerminalPublish(existingPath, newPath, ...args) {
    if (newPath.startsWith(`${terminalDir}${path.sep}`)) {
      const error = new Error('injected terminal link failure');
      error.code = 'EIO';
      throw error;
    }
    return originalLinkSync.call(this, existingPath, newPath, ...args);
  };
  try {
    const [outcome] = await outbox.drain(async () => ({
      status: 400,
      mediaType: 'application/json',
      body: JSON.stringify({ error: { code: 'invalid_host_prompt_id' } }),
    }));
    assert.equal(outcome.terminal, false);
    assert.equal(outcome.primaryRemoved, false);
    assert.equal(outcome.terminalReason, 'terminal_io_error');
  } finally {
    fs.linkSync = originalLinkSync;
  }
  assert.deepEqual(outbox.listPending().map((entry) => entry.id), [intent.id]);
  assert.equal(outbox.isTerminalRejected(intent.id), false);
});

test('delivery fences recover captured turns and deferred entries do not consume the replay budget', async () => {
  const serverPromptId = '44444444-4444-4444-8444-444444444444';
  const capturedBarrier = session.advanceBarrier('captured-fence', 'normal-pending');
  assert.ok(session.attachActive('captured-fence', {
    epoch: capturedBarrier.epoch,
    clientEventId: 'captured-event',
    submitPromptId: 'captured-host',
    submittedAt: new Date().toISOString(),
    transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
    frozenPayloadHash: 'a'.repeat(64),
    status: 'submitting',
  }));
  assert.ok(session.promoteActive('captured-fence', 'captured-event', 'captured-host', serverPromptId));
  const captured = fencedResponse('captured-fence', capturedBarrier.epoch, 'captured-event', 'captured-host', serverPromptId, '2026-01-01T00:00:00.000Z');
  assert.equal(outbox.enqueue(captured), true);
  const [recovered] = await outbox.drain(async () => ({ status: 202 }));
  assert.equal(recovered.acked, true);
  assert.equal(session.readTurn('captured-fence').active.status, 'consumed');

  const futureBarrier = session.advanceBarrier('future-fence', 'normal-pending');
  assert.equal(outbox.enqueue(fencedResponse(
    'future-fence', futureBarrier.epoch + 1, 'future-event', 'future-host', serverPromptId, '2026-01-02T00:00:00.000Z',
  )), true);
  assert.equal(outbox.enqueue({ ...responseEntry('legacy-after-deferred'), createdAt: '2026-01-02T00:00:01.000Z' }), true);
  const sent = [];
  const outcomes = await outbox.drain(async (entry) => {
    sent.push(entry.id);
    return { status: 202 };
  }, { limit: 1 });
  assert.equal(outcomes[0].deferred, true);
  assert.deepEqual(sent, ['legacy-after-deferred']);
  assert.equal(outcomes[1].acked, true);
});

test('fences allow only absent or advanced session state, and fail closed for an existing unreadable record', async () => {
  const serverPromptId = '77777777-7777-4777-8777-777777777777';
  const absent = fencedResponse('absent-fence', 1, 'absent-event', 'absent-host', serverPromptId, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(outbox.responseFenceAllowsDelivery(absent), { allowed: true, status: 'ready_absent' });

  const staleBarrier = session.advanceBarrier('stale-fence', 'normal-pending');
  session.advanceBarrier('stale-fence', 'normal-pending');
  const stale = fencedResponse('stale-fence', staleBarrier.epoch, 'stale-event', 'stale-host', serverPromptId, '2026-01-03T00:00:01.000Z');
  assert.deepEqual(outbox.responseFenceAllowsDelivery(stale), { allowed: true, status: 'ready_invalidated' });

  const missingSessionId = 'present-without-turn';
  const sessionDir = path.join(
    process.env.CLAUDE_PLUGIN_DATA,
    'runtime',
    'sessions',
    crypto.createHash('sha256').update(missingSessionId).digest('hex'),
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  const blocked = fencedResponse(missingSessionId, 1, 'blocked-event', 'blocked-host', serverPromptId, '2026-01-03T00:00:02.000Z');
  assert.deepEqual(outbox.responseFenceAllowsDelivery(blocked), { allowed: false, status: 'blocked_missing' });
  assert.equal(outbox.enqueue(blocked), true);
  let sends = 0;
  const [outcome] = await outbox.drain(async () => {
    sends += 1;
    return { status: 202 };
  });
  assert.equal(sends, 0);
  assert.equal(outcome.deferred, true);
  assert.equal(outcome.fenceStatus, 'blocked_missing');
});

test('drain sends a pending prompt before its dependent response', async () => {
  assert.equal(outbox.enqueue(responseEntry('response-after-prompt', 'prompt-before-response')), true);
  assert.equal(outbox.enqueue({
    id: 'prompt-before-response',
    kind: 'prompt',
    payload: { prompt_text: 'prompt' },
  }), true);

  const order = [];
  await outbox.drain(async (entry) => {
    order.push(entry.id);
    return { status: 200, body: 'ok' };
  });
  assert.deepEqual(order, ['prompt-before-response', 'response-after-prompt']);
  assert.deepEqual(outbox.listPending(), []);
});

test('corrupt entry files are skipped without preventing a drain', async () => {
  fs.mkdirSync(outbox.getOutboxDir(), { recursive: true });
  fs.writeFileSync(path.join(outbox.getOutboxDir(), `${'a'.repeat(64)}.json`), '{partial');
  assert.deepEqual(outbox.listPending(), []);
  const result = await outbox.drain(async () => {
    throw new Error('sender should not run');
  });
  assert.deepEqual(result, []);
});

test('cap retains a consumed-turn response while evicting older prompt intents', () => {
  assert.equal(outbox.enqueue({
    ...responseEntry('response-consumed'),
    createdAt: new Date(0).toISOString(),
  }), true);
  for (let index = 0; index < outbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(outbox.enqueue({
      ...promptEntry(`prompt-cap-${index}`),
      createdAt: new Date((index + 1) * 1000).toISOString(),
    }), true);
  }

  const pending = outbox.listPending();
  assert.equal(pending.length, outbox.MAX_PENDING_ENTRIES);
  assert.equal(pending.some((entry) => entry.id === 'response-consumed'), true);
  assert.equal(pending.some((entry) => entry.id === 'prompt-cap-0'), false);
  assert.equal(pending.some((entry) => entry.id === `prompt-cap-${outbox.MAX_PENDING_ENTRIES - 1}`), true);
});
test('response-only cap fails closed without evicting an existing response', () => {
  for (let index = 0; index < outbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(outbox.enqueue({
      ...responseEntry(`response-cap-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }

  assert.equal(outbox.enqueue(responseEntry('response-cap-overflow')), false);
  const pending = outbox.listPending();
  assert.equal(pending.length, outbox.MAX_PENDING_ENTRIES);
  assert.equal(pending.some((entry) => entry.id === 'response-cap-0'), true);
  assert.equal(pending.some((entry) => entry.id === 'response-cap-overflow'), false);
});
test('MAX_PENDING_BYTES evicts oldest prompts first, never responses, ahead of the count cap', () => {
  const entryBytes = 3 * 1024 * 1024;
  assert.equal(outbox.enqueue({
    ...responseEntry('big-response-protected'),
    createdAt: new Date(0).toISOString(),
    payload: { response_text: 'x'.repeat(1024) },
  }), true);

  const bigText = 'x'.repeat(entryBytes);
  const entryCount = Math.ceil(outbox.MAX_PENDING_BYTES / entryBytes) + 5;
  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(outbox.enqueue({
      ...promptEntry(`big-prompt-${index}`),
      payload: { prompt_text: bigText },
      createdAt: new Date((index + 1) * 1000).toISOString(),
    }), true);
  }

  const pending = outbox.listPending();
  const totalBytes = pending.reduce((sum, entry) => sum + outbox.serializedEntryBytes(entry), 0);
  assert.equal(totalBytes <= outbox.MAX_PENDING_BYTES, true);
  assert.equal(pending.length < entryCount + 1, true);
  assert.equal(pending.some((entry) => entry.id === 'big-response-protected'), true);
  assert.equal(pending.some((entry) => entry.id === 'big-prompt-0'), false);
  assert.equal(pending.some((entry) => entry.id === `big-prompt-${entryCount - 1}`), true);
});

test('keeps a successful prompt queued until its server id promotion is durable', async () => {
  const intent = {
    id: 'prompt-promotion',
    kind: 'prompt',
    payload: { prompt_text: 'prompt' },
    promotion: {
      sessionId: 'session-promotion',
      epoch: 1,
      clientEventId: 'event-promotion',
      hostPromptId: 'host-promotion',
    },
  };
  assert.equal(outbox.enqueue(intent), true);
  const first = await outbox.drain(async () => ({ status: 201, body: '{"id":"server"}', ack: false }));
  assert.equal(first[0].acked, false);
  assert.equal(outbox.listPending().length, 1);

  const second = await outbox.drain(async () => ({ status: 201, body: '{"id":"server"}', ack: true }));
  assert.equal(second[0].acked, true);
  assert.deepEqual(outbox.listPending(), []);
});
test('drain delivers a response after only its own pending prompt dependency', async () => {
  for (let index = 0; index < 32; index += 1) {
    assert.equal(outbox.enqueue({
      ...promptEntry(`stuck-unrelated-prompt-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }
  assert.equal(outbox.enqueue({
    ...promptEntry('prompt-required-by-response'),
    createdAt: new Date(33_000).toISOString(),
  }), true);
  assert.equal(outbox.enqueue({
    ...responseEntry('response-not-starved', 'prompt-required-by-response'),
    createdAt: new Date(34_000).toISOString(),
  }), true);

  const sent = [];
  await outbox.drain(async (entry) => {
    sent.push(entry.id);
    return { status: entry.id.startsWith('stuck-') ? 503 : 202 };
  }, { limit: 2 });

  assert.deepEqual(sent, ['prompt-required-by-response', 'response-not-starved']);
  assert.equal(outbox.listPending().some((entry) => entry.id === 'response-not-starved'), false);
});
test('same intent validates after JSON serialization drops undefined response fields', () => {
  const intent = {
    ...responseEntry('response-undefined-fields'),
    payload: {
      response_text: 'complete',
      model: undefined,
      cost_usd: undefined,
    },
  };
  assert.equal(outbox.enqueue(intent), true);
  assert.equal(outbox.enqueue(intent), true);
  const [pending] = outbox.listPending();
  assert.equal(outbox.listPending().length, 1);
  assert.equal(pending.id, intent.id);
  assert.deepEqual(pending.payload, { response_text: 'complete' });
});
test('replays only the prompt matching a promotion correlation', async () => {
  const prompt = {
    id: 'prompt-targeted-replay',
    kind: 'prompt',
    payload: { prompt_text: 'prompt' },
    promotion: {
      sessionId: 'target-session',
      epoch: 2,
      clientEventId: 'target-event',
      hostPromptId: 'target-host-prompt',
    },
  };
  assert.equal(outbox.enqueue(responseEntry('unrelated-response')), true);
  assert.equal(outbox.enqueue(prompt), true);

  const sent = [];
  const outcomes = await outbox.replayPrompt({
    sessionId: 'target-session',
    epoch: 2,
    clientEventId: 'target-event',
    hostPromptId: 'target-host-prompt',
  }, async (entry) => {
    sent.push(entry.id);
    return { status: 201, ack: true };
  });

  assert.deepEqual(sent, ['prompt-targeted-replay']);
  assert.deepEqual(outcomes.map(({ id, acked }) => ({ id, acked })), [{ id: 'prompt-targeted-replay', acked: true }]);
  assert.deepEqual(outbox.listPending().map((entry) => entry.id), ['unrelated-response']);
});
test('drain and replayPrompt count large backlog lookup time against their deadlines', async () => {
  for (let index = 0; index < 31; index += 1) {
    assert.equal(outbox.enqueue(responseEntry(`lookup-backlog-${index}`)), true);
  }
  assert.equal(outbox.enqueue({
    id: 'prompt-lookup-target',
    kind: 'prompt',
    payload: { prompt_text: 'target' },
    promotion: {
      sessionId: 'lookup-session',
      epoch: 1,
      clientEventId: 'lookup-event',
      hostPromptId: 'lookup-host',
    },
  }), true);

  const originalReadFileSync = fs.readFileSync;
  const outboxDir = `${outbox.getOutboxDir()}${path.sep}`;
  let sends = 0;
  fs.readFileSync = function delayedOutboxRead(file, ...args) {
    if (typeof file === 'string' && file.startsWith(outboxDir)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return originalReadFileSync.call(this, file, ...args);
  };
  let drainOutcomes;
  let replayOutcomes;
  try {
    drainOutcomes = await outbox.drain(async () => {
      sends += 1;
      return { status: 202 };
    }, { maxElapsedMs: 100, minRequestMs: 25 });
    replayOutcomes = await outbox.replayPrompt({
      sessionId: 'lookup-session',
      epoch: 1,
      clientEventId: 'lookup-event',
      hostPromptId: 'lookup-host',
    }, async () => {
      sends += 1;
      return { status: 202 };
    }, { maxElapsedMs: 100, minRequestMs: 25 });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.deepEqual(drainOutcomes, []);
  assert.deepEqual(replayOutcomes, []);
  assert.equal(sends, 0);
});

test('prioritizes the current intent and bounds a replay pass', async () => {
  for (let index = 0; index < 33; index += 1) {
    assert.equal(outbox.enqueue({
      ...responseEntry(`older-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }
  assert.equal(outbox.enqueue({
    ...responseEntry('current'),
    createdAt: new Date(34 * 1000).toISOString(),
  }), true);

  const sent = [];
  const outcomes = await outbox.drain(async (entry) => {
    sent.push(entry.id);
    return { status: 202 };
  }, { limit: 2, maxElapsedMs: 2000, prioritizeIds: ['current'] });

  assert.deepEqual(sent, ['current', 'older-0']);
  assert.equal(outcomes.length, 2);
  assert.equal(outbox.listPending().length, 32);
});

test('repairs a corrupt EEXIST final and rejects a conflicting final as durable', () => {
  const intent = {
    ...responseEntry('repair-final'),
    createdAt: '2026-07-17T00:00:00.000Z',
  };
  fs.mkdirSync(outbox.getOutboxDir(), { recursive: true });
  fs.writeFileSync(entryFile(intent.id), '{corrupt');
  assert.equal(outbox.enqueue(intent), true);
  assert.deepEqual(outbox.listPending(), [{ ...intent }]);
  assert.ok(fs.readdirSync(outbox.getOutboxDir()).some((name) => name.endsWith('.corrupt')));
  assert.equal(outbox.enqueue({ ...intent, createdAt: '2026-07-17T00:01:00.000Z' }), true);

  assert.equal(outbox.enqueue({
    ...intent,
    payload: { response_text: 'conflicting' },
  }), false);
  assert.deepEqual(outbox.listPending(), [{ ...intent }]);
});

test('reaps aged orphan temps without deleting a live publisher temp', () => {
  fs.mkdirSync(outbox.getOutboxDir(), { recursive: true });
  const orphan = path.join(outbox.getOutboxDir(), '.00000000-0000-4000-8000-000000000000.tmp');
  const live = path.join(outbox.getOutboxDir(), '.00000000-0000-4000-8000-000000000001.tmp');
  fs.writeFileSync(orphan, 'orphan');
  fs.writeFileSync(live, 'live');
  const old = new Date(Date.now() - outbox.ORPHAN_TEMP_AGE_MS - 1_000);
  fs.utimesSync(orphan, old, old);

  assert.equal(outbox.enqueue(responseEntry('after-orphan')), true);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(live), true);
});

test('logs prompt eviction at the outbox cap', () => {
  for (const modulePath of ['../lib/response-outbox', '../lib/debug', '../lib/env']) {
    delete require.cache[require.resolve(modulePath)];
  }
  const freshOutbox = require('../lib/response-outbox');
  for (let index = 0; index <= freshOutbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(freshOutbox.enqueue({
      ...promptEntry(`debug-cap-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }
  assert.match(fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'debug.log'), 'utf8'), /DROP outbox prompt beyond cap/);
});
