const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SESSION_END = path.join(ROOT, 'hooks', 'scripts', 'session-end-handler.js');
const session = require('../lib/session');

// Every in-process test below requires session-end-handler.js (and, through
// it, lib/env.js) directly rather than spawning a subprocess. lib/env.js
// reads ~/.prism/config.json once at module-load time via os.homedir(), so
// without isolating HOME here these tests would read this machine's own
// real Prism config — and, once the handler can send network requests, could
// send them to a real ingest service. Every module on this list computes
// something from HOME/config at require time and must be re-required after
// HOME changes.
const ENV_SENSITIVE_MODULES = [
  '../lib/config', '../lib/binding', '../lib/env',
  '../lib/session', '../lib/response-outbox',
  '../lib/host-observation-state', '../lib/host-observation-collection',
  '../lib/ingest', '../lib/outbox-delivery',
];

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function resetEnvSensitiveModules() {
  for (const modulePath of ENV_SENSITIVE_MODULES) {
    delete require.cache[require.resolve(modulePath)];
  }
}

function writeConfig(home, config) {
  const configFile = path.join(home, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config));
}

// A minimal ack-shaped local server standing in for ingest: `onRequest`
// decides the response per parsed body, so a test can single out one entry
// among a batch (contract §5 ack shape: {ack_version, occurrence_id,
// client_event_id, status}).
function startServer(onRequest) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      requests.push({ path: request.url, body: parsed });
      onRequest(request, response, parsed);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      port: server.address().port,
      close: () => new Promise((res) => server.close(res)),
    }));
  });
}

function ackResponse(response, parsed) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    ack_version: 1,
    occurrence_id: 'occurrence',
    client_event_id: parsed && parsed.adapter_event_id,
    status: 'accepted',
  }));
}

test('hooks.json registers the SessionEnd handler', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(Array.isArray(hooks.hooks.SessionEnd));
  const command = hooks.hooks.SessionEnd[0].hooks[0].command;
  assert.match(command, /session-end-handler\.js$/);
});

test('SessionEnd enqueues session_end and any pending observation without any network call', () => {
  const home = temp('prism-session-end-home-');
  const data = temp('prism-session-end-data-');
  const file = path.join(home, 'transcript.jsonl');
  const promptId = 'session-end-prompt';
  fs.writeFileSync(file, [
    JSON.stringify({
      type: 'attachment',
      uuid: 'queued-row-uuid',
      parentUuid: 'parent-row-uuid',
      timestamp: '2026-07-02T00:00:01.000Z',
      attachment: {
        type: 'queued_command', prompt: 'left over instruction', origin: { kind: 'human' }, isMeta: false,
      },
    }),
    '',
  ].join('\n'));
  try {
    process.env.CLAUDE_PLUGIN_DATA = data;
    const barrier = session.advanceBarrier('session-end-session', 'normal-pending');
    assert.ok(session.attachActive('session-end-session', {
      epoch: barrier.epoch,
      clientEventId: 'session-end-event',
      submitPromptId: promptId,
      submittedAt: new Date().toISOString(),
      transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
      frozenPayloadHash: crypto.createHash('sha256').update('session-end').digest('hex'),
      status: 'submitting',
    }));

    // Intentionally no API key/ingest URL and no interceptor: if this
    // handler ever attempted a network call it would hang or error against
    // an unconfigured target, so a clean, fast exit demonstrates it did not.
    const started = Date.now();
    const result = spawnSync(process.execPath, [SESSION_END], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 3000,
      input: JSON.stringify({ session_id: 'session-end-session', reason: 'clear', transcript_path: file }),
      env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data },
    });
    const elapsedMs = Date.now() - started;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs < 3000, `session-end-handler took ${elapsedMs}ms`);

    const pending = require('../lib/response-outbox').listPending();
    const sessionEnd = pending.find((entry) => entry.kind === 'session_end');
    const queuedInput = pending.find((entry) => entry.kind === 'queued_input');
    assert.ok(sessionEnd, 'expected a session_end entry');
    assert.equal(sessionEnd.payload.reason, 'clear');
    assert.equal(sessionEnd.payload.last_active_host_prompt_id, promptId);
    assert.ok(queuedInput, 'expected the queued instruction recorded past the last active boundary');
    assert.equal(queuedInput.payload.attached_under_host_prompt_id, promptId);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

function loadSessionEndHandlerWithFakeStdin(hookInput) {
  const stdinPath = require.resolve('../lib/stdin');
  const handlerPath = require.resolve(SESSION_END);
  delete require.cache[stdinPath];
  delete require.cache[handlerPath];
  require.cache[stdinPath] = {
    id: stdinPath,
    filename: stdinPath,
    loaded: true,
    exports: { readStdin: () => Promise.resolve(hookInput) },
  };
  return require(handlerPath);
}

// `sequenceAfterFirst[i]` is the elapsed-since-start value main()'s
// (i+2)-th Date.now() call should observe (its 1st call is always the real
// `startedAt`); once the sequence is exhausted, its last value repeats.
function withMockedElapsedSequence(sequenceAfterFirst, fn) {
  const realNow = Date.now;
  let callCount = 0;
  const startedAt = realNow.call(Date);
  Date.now = () => {
    callCount += 1;
    if (callCount === 1) return startedAt;
    const index = Math.min(callCount - 2, sequenceAfterFirst.length - 1);
    return startedAt + sequenceAfterFirst[index];
  };
  return Promise.resolve(fn()).finally(() => { Date.now = realNow; });
}

function withMockedElapsed(elapsedAfterStartMs, fn) {
  return withMockedElapsedSequence([elapsedAfterStartMs], fn);
}

function queuedAttachmentTranscript() {
  return JSON.stringify({
    type: 'attachment',
    uuid: 'queued-row-uuid',
    attachment: { type: 'queued_command', prompt: 'left over instruction', origin: { kind: 'human' }, isMeta: false },
  }) + '\n';
}

function setUpActiveRecord(sessionId, promptId) {
  const barrier = session.advanceBarrier(sessionId, 'normal-pending');
  assert.ok(session.attachActive(sessionId, {
    epoch: barrier.epoch,
    clientEventId: `${sessionId}-event`,
    submitPromptId: promptId,
    submittedAt: new Date().toISOString(),
    transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
    frozenPayloadHash: crypto.createHash('sha256').update(sessionId).digest('hex'),
    status: 'submitting',
  }));
}

test('a transcript read that would exceed the budget is skipped, recording a gap, but session_end still enqueues', async () => {
  const home = temp('prism-session-end-budget-home-');
  const data = temp('prism-session-end-budget-data-');
  const file = path.join(home, 'transcript.jsonl');
  const promptId = 'session-end-budget-prompt';
  fs.writeFileSync(file, JSON.stringify({
    type: 'attachment',
    uuid: 'queued-row-uuid',
    attachment: { type: 'queued_command', prompt: 'never read', origin: { kind: 'human' }, isMeta: false },
  }) + '\n');
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  try {
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.HOME = home; // isolates lib/env.js from this machine's real ~/.prism/config.json
    resetEnvSensitiveModules();
    const session = require('../lib/session');
    const outbox = require('../lib/response-outbox');
    const barrier = session.advanceBarrier('session-end-budget-session', 'normal-pending');
    assert.ok(session.attachActive('session-end-budget-session', {
      epoch: barrier.epoch,
      clientEventId: 'session-end-budget-event',
      submitPromptId: promptId,
      submittedAt: new Date().toISOString(),
      transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
      frozenPayloadHash: crypto.createHash('sha256').update('session-end-budget').digest('hex'),
      status: 'submitting',
    }));

    // 1100ms elapsed: past TRANSCRIPT_READ_BUDGET_MS (1000ms) but under
    // TOTAL_BUDGET_MS (1400ms), so the read is skipped but session_end still
    // gets enqueued.
    await withMockedElapsed(1100, async () => {
      const handler = loadSessionEndHandlerWithFakeStdin({
        session_id: 'session-end-budget-session', reason: 'other', transcript_path: file,
      });
      await handler.main();
    });

    const pending = outbox.listPending();
    assert.equal(pending.some((entry) => entry.kind === 'queued_input'), false, 'the budget-exceeded read must not run');
    const sessionEnd = pending.find((entry) => entry.kind === 'session_end');
    assert.ok(sessionEnd, 'session_end should still enqueue under the total budget');
    const terminalDir = outbox.getTerminalRejectedDir();
    const terminalFiles = fs.existsSync(terminalDir) ? fs.readdirSync(terminalDir) : [];
    const gapRecorded = terminalFiles.some((name) => {
      const value = JSON.parse(fs.readFileSync(path.join(terminalDir, name), 'utf8'));
      return value.terminalReason === 'session_end_budget_exceeded';
    });
    assert.equal(gapRecorded, true, 'expected a recorded gap for the skipped read');
  } finally {
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('exceeding the total budget stops all work, including the network-free session_end enqueue', async () => {
  const home = temp('prism-session-end-total-budget-home-');
  const data = temp('prism-session-end-total-budget-data-');
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  try {
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.HOME = home;
    resetEnvSensitiveModules();
    const outbox = require('../lib/response-outbox');

    // 1500ms elapsed: past TOTAL_BUDGET_MS (1400ms) by the time stdin
    // resolves, so nothing further runs.
    await withMockedElapsed(1500, async () => {
      const handler = loadSessionEndHandlerWithFakeStdin({ session_id: 'session-end-total-budget-session', reason: 'other' });
      await handler.main();
    });

    assert.deepEqual(outbox.listPending(), []);
  } finally {
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('SessionEnd with no active record and no session id is a safe no-op', () => {
  const home = temp('prism-session-end-noop-home-');
  const data = temp('prism-session-end-noop-');
  try {
    process.env.CLAUDE_PLUGIN_DATA = data;
    const missingSession = spawnSync(process.execPath, [SESSION_END], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 3000,
      input: JSON.stringify({ reason: 'other' }),
      env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data },
    });
    assert.equal(missingSession.status, 0, missingSession.stderr);
    assert.deepEqual(require('../lib/response-outbox').listPending(), []);
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('SessionEnd success path sends every enqueued entry and leaves the outbox empty', async () => {
  const home = temp('prism-session-end-success-home-');
  const data = temp('prism-session-end-success-data-');
  const file = path.join(home, 'transcript.jsonl');
  const promptId = 'session-end-success-prompt';
  fs.writeFileSync(file, queuedAttachmentTranscript());
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  let handle;
  try {
    handle = await startServer((request, response, parsed) => ackResponse(response, parsed));
    writeConfig(home, { apiKey: 'session-end-test-key', ingest_url: `http://127.0.0.1:${handle.port}` });
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.HOME = home;
    resetEnvSensitiveModules();
    const outbox = require('../lib/response-outbox');
    setUpActiveRecord('session-end-success-session', promptId);

    // No Date.now mocking here: this test exercises the real network path
    // (a real local server and drain()'s real deadline), which a frozen
    // clock would silently defeat (post()'s socket timeout is computed from
    // deadline - Date.now(), and both call sites must see real time move).
    const handler = loadSessionEndHandlerWithFakeStdin({
      session_id: 'session-end-success-session', reason: 'clear', transcript_path: file,
    });
    await handler.main();

    assert.deepEqual(outbox.listPending(), []);
    assert.equal(handle.requests.length, 2);
    assert.deepEqual(handle.requests.map((r) => r.path).sort(), [
      '/v1/host-observations/queued-input', '/v1/host-observations/session-end',
    ]);
  } finally {
    if (handle) await handle.close();
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a stubbed server that never responds leaves every entry pending and the handler still returns before 1500ms', async () => {
  const home = temp('prism-session-end-hang-home-');
  const data = temp('prism-session-end-hang-data-');
  const file = path.join(home, 'transcript.jsonl');
  const promptId = 'session-end-hang-prompt';
  fs.writeFileSync(file, queuedAttachmentTranscript());
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  let handle;
  try {
    // Accepts the connection but never writes a response.
    handle = await startServer(() => {});
    writeConfig(home, { apiKey: 'session-end-test-key', ingest_url: `http://127.0.0.1:${handle.port}` });
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.HOME = home;
    resetEnvSensitiveModules();
    const outbox = require('../lib/response-outbox');
    setUpActiveRecord('session-end-hang-session', promptId);

    // No Date.now mocking: this test proves the real socket-level timeout
    // (derived from post()'s deadline option) actually fires against a
    // truly unresponsive peer.
    const wallClockStart = Date.now();
    const handler = loadSessionEndHandlerWithFakeStdin({
      session_id: 'session-end-hang-session', reason: 'other', transcript_path: file,
    });
    await handler.main();
    const elapsedMs = Date.now() - wallClockStart;

    assert.ok(elapsedMs < 1500, `handler took ${elapsedMs}ms`);
    const pending = outbox.listPending();
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((entry) => entry.kind).sort(), ['queued_input', 'session_end']);
  } finally {
    if (handle) { handle.server.closeAllConnections?.(); await handle.close(); }
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a budget already exhausted before step 3 skips sending but keeps the enqueued entry', async () => {
  const home = temp('prism-session-end-late-budget-home-');
  const data = temp('prism-session-end-late-budget-data-');
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  let handle;
  try {
    handle = await startServer((request, response, parsed) => ackResponse(response, parsed));
    writeConfig(home, { apiKey: 'session-end-test-key', ingest_url: `http://127.0.0.1:${handle.port}` });
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.HOME = home;
    resetEnvSensitiveModules();
    const outbox = require('../lib/response-outbox');
    // No active record: this isolates the exact call sequence to main()'s
    // own two TOTAL_BUDGET_MS checks plus the remaining-budget computation
    // (3 calls after `startedAt`), so the elapsed sequence below can target
    // the last of those precisely without depending on how many internal
    // Date.now() calls a transcript read happens to make.
    await withMockedElapsedSequence([100, 100, 1450], async () => {
      const handler = loadSessionEndHandlerWithFakeStdin({ session_id: 'session-end-late-budget-session', reason: 'other' });
      await handler.main();
    });

    assert.equal(handle.requests.length, 0, 'no request should have been attempted');
    const pending = outbox.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'session_end');
  } finally {
    if (handle) await handle.close();
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a mid-batch failure leaves only the unsent entry, not the whole batch', async () => {
  const home = temp('prism-session-end-mid-batch-home-');
  const data = temp('prism-session-end-mid-batch-data-');
  const file = path.join(home, 'transcript.jsonl');
  const promptId = 'session-end-mid-batch-prompt';
  fs.writeFileSync(file, queuedAttachmentTranscript());
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  let handle;
  try {
    handle = await startServer((request, response, parsed) => {
      if (request.url === '/v1/host-observations/queued-input') {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('temporary failure');
        return;
      }
      ackResponse(response, parsed);
    });
    writeConfig(home, { apiKey: 'session-end-test-key', ingest_url: `http://127.0.0.1:${handle.port}` });
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.HOME = home;
    resetEnvSensitiveModules();
    const outbox = require('../lib/response-outbox');
    setUpActiveRecord('session-end-mid-batch-session', promptId);

    const handler = loadSessionEndHandlerWithFakeStdin({
      session_id: 'session-end-mid-batch-session', reason: 'other', transcript_path: file,
    });
    await handler.main();

    const pending = outbox.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'queued_input');
  } finally {
    if (handle) await handle.close();
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('missing API key keeps SessionEnd an enqueue-only run: entries persist and no request is attempted', async () => {
  const home = temp('prism-session-end-no-key-home-');
  const data = temp('prism-session-end-no-key-data-');
  const file = path.join(home, 'transcript.jsonl');
  const promptId = 'session-end-no-key-prompt';
  fs.writeFileSync(file, queuedAttachmentTranscript());
  const previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousHome = process.env.HOME;
  let handle;
  try {
    handle = await startServer((request, response, parsed) => ackResponse(response, parsed));
    // No config.json at all: no apiKey, no ingest_url.
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.HOME = home;
    resetEnvSensitiveModules();
    const outbox = require('../lib/response-outbox');
    setUpActiveRecord('session-end-no-key-session', promptId);

    const handler = loadSessionEndHandlerWithFakeStdin({
      session_id: 'session-end-no-key-session', reason: 'other', transcript_path: file,
    });
    await handler.main();

    assert.equal(handle.requests.length, 0);
    const pending = outbox.listPending();
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((entry) => entry.kind).sort(), ['queued_input', 'session_end']);
  } finally {
    if (handle) await handle.close();
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
