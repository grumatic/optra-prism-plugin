const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const STOP = path.join(ROOT, 'hooks', 'scripts', 'stop-handler.js');
const session = require('../lib/session');
const PREFLIGHT_FIXTURE = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'test', 'fixtures', 'preflight-fixture.json'),
  'utf8',
));
const {
  proveTranscriptTurn,
  consumeUsage,
  gradeFor,
  MAX_TRANSCRIPT_BYTES,
  pricingFor,
  isOpusModel,
} = require('../lib/realtime');

const SERVER_PROMPT_ID = '11111111-1111-4111-8111-111111111111';
const dirs = [];
function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function active(
  sessionId,
  promptId,
  transcriptPath,
  submittedAt = new Date().toISOString(),
  serverPromptId = SERVER_PROMPT_ID,
) {
  const barrier = session.advanceBarrier(sessionId, 'normal-pending');
  const attached = session.attachActive(sessionId, {
    epoch: barrier.epoch,
    clientEventId: `event-${sessionId}`,
    submitPromptId: promptId,
    submittedAt,
    transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
    frozenPayloadHash: crypto.createHash('sha256').update(sessionId).digest('hex'),
    status: 'submitting',
  });
  assert.ok(attached);
  assert.ok(session.promoteActive(sessionId, `event-${sessionId}`, promptId, serverPromptId));
  return transcriptPath;
}
function transcript(promptId, content, usages) {
  return [
    JSON.stringify({ type: 'user', prompt_id: promptId, message: { role: 'user', content: 'request' } }),
    ...usages.map((usage, index) => JSON.stringify({
      type: 'assistant',
      uuid: `assistant-${index}`,
      message: { role: 'assistant', stop_reason: 'end_turn', content: index === usages.length - 1 ? content : `tool ${index}`, model: usage.model, usage: {
        input_tokens: usage.input,
        cache_read_input_tokens: usage.cacheRead || 0,
        cache_creation_input_tokens: usage.cacheCreation || 0,
        output_tokens: usage.output,
      } },
    })),
  ].join('\n') + '\n';
}
function interceptor(home, statusCode = 202) {
  const hook = path.join(home, 'http.js');
  fs.writeFileSync(hook, [
    "const events = require('node:events');",
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  let body = ""; const request = new events.EventEmitter();',
    '  request.write = (chunk) => { body += chunk; }; request.destroy = () => {};',
    `  request.end = () => { fs.writeFileSync(process.env.RESPONSE_MARKER, body); const response = new events.EventEmitter(); response.statusCode = ${statusCode}; callback(response); response.emit("end"); };`,
    '  return request;',
    '};',
  ].join('\n'));
  return hook;
}

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('preflight fixture confirms the exact host prompt correlation contract', () => {
  assert.equal(PREFLIGHT_FIXTURE.userPromptSubmit.prompt_id, PREFLIGHT_FIXTURE.stop.prompt_id);
  assert.equal(typeof PREFLIGHT_FIXTURE.stop.prompt_id, 'string');
  assert.equal(Object.hasOwn(PREFLIGHT_FIXTURE.stop, 'input_tokens'), false);
  assert.equal(Object.hasOwn(PREFLIGHT_FIXTURE.stop, 'model'), false);
});
test('exact Stop consumes one proven multi-assistant turn and separates totals from last context', () => {
  const home = temp('prism-realtime-home-');
  const data = temp('prism-realtime-data-');
  const file = path.join(home, 'transcript.jsonl');
  const marker = path.join(home, 'response.json');
  const promptId = 'host-prompt-1';
  const text = 'final assistant content';
  fs.writeFileSync(file, transcript(promptId, text, [
    { input: 10_000, output: 10, model: 'claude-sonnet-4-6' },
    { input: 20_000, output: 10, model: 'claude-sonnet-4-6' },
    { input: 30_000, output: 10, model: 'claude-sonnet-4-6' },
  ]));
  process.env.CLAUDE_PLUGIN_DATA = data;
  active('exact-stop', promptId, file);
  const result = spawnSync(process.execPath, [STOP], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'exact-stop', prompt_id: promptId, transcript_path: file, last_assistant_message: text }),
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data, PRISM_API_KEY: 'prism_test', PRISM_INGEST_URL: 'http://127.0.0.1:9', RESPONSE_MARKER: marker, NODE_OPTIONS: `--require=${interceptor(home)}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"systemMessage":"\[Prism\] Lite A\+/);
  const summary = session.readSummary('exact-stop');
  assert.equal(summary.consumedTotals.input, 60_000);
  assert.equal(summary.contextHealth.lastInputTokens, 30_000);
  assert.equal(summary.contextHealth.turnCount, 1);
  const response = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(response.prompt_id, SERVER_PROMPT_ID);
  assert.equal(response.client_event_id, 'event-exact-stop');
  assert.equal(session.readTurn('exact-stop').active.status, 'consumed');
});
test('failed response capture retains accounting after the active turn is consumed', () => {
  const home = temp('prism-realtime-failed-response-home-');
  const data = temp('prism-realtime-failed-response-data-');
  const file = path.join(home, 'turn.jsonl');
  const marker = path.join(home, 'response.json');
  const promptId = 'failed-response-prompt';
  const text = 'failed response reply';
  fs.writeFileSync(file, transcript(promptId, text, [{ input: 321, output: 12, model: 'claude-sonnet-4-6' }]));
  process.env.CLAUDE_PLUGIN_DATA = data;
  active('failed-response', promptId, file);

  const result = spawnSync(process.execPath, [STOP], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'failed-response', prompt_id: promptId, transcript_path: file, last_assistant_message: text }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: data,
      PRISM_API_KEY: 'prism_test',
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      RESPONSE_MARKER: marker,
      NODE_OPTIONS: `--require=${interceptor(home, 503)}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Realtime summary unavailable: response capture failed/);
  assert.equal(session.readTurn('failed-response').active.status, 'consumed');
  const summary = session.readSummary('failed-response');
  assert.equal(summary.contextHealth.turnCount, 1);
  assert.equal(summary.consumedTotals.input, 321);
  assert.equal(summary.processedUsageIds.length, 1);
});

test('control, stale, expired, prompt mismatch, and transcript lag leave active records unconsumed', async () => {
  const dir = temp('prism-realtime-skip-');
  const file = path.join(dir, 'turn.jsonl');
  fs.writeFileSync(file, '');
  process.env.CLAUDE_PLUGIN_DATA = dir;
  const promptId = 'skip-prompt';
  active('skip-control', promptId, file);
  session.advanceBarrier('skip-control', 'control');
  assert.equal(session.readTurn('skip-control').active.status, 'invalidated');
  active('skip-cas', promptId, file);
  const turn = session.readTurn('skip-cas');
  assert.ok(session.consumeActive('skip-cas', {
    epoch: turn.epoch,
    clientEventId: turn.active.clientEventId,
    submitPromptId: promptId,
    serverPromptId: turn.active.serverPromptId,
  }));
  assert.equal(session.consumeActive('skip-cas', {
    epoch: turn.epoch,
    clientEventId: turn.active.clientEventId,
    submitPromptId: promptId,
    serverPromptId: turn.active.serverPromptId,
  }), null);
  assert.equal(await proveTranscriptTurn({ transcriptPath: file, boundary: { byteOffset: 0 }, promptId }), null);
});

test('usage dedupe, unknown pricing, and the Lite rubric preserve specified boundaries', () => {
  const usage = [
    { id: 'a'.repeat(64), input: 10, cacheRead: 0, cacheCreation: 0, output: 1, model: 'unknown' },
    { id: 'b'.repeat(64), input: 20, cacheRead: 0, cacheCreation: 0, output: 1, model: 'claude-sonnet-4-6' },
  ];
  const first = consumeUsage(usage, []);
  assert.equal(first.totals.input, 30);
  assert.equal(first.totals.unknownCost, true);
  const deduped = consumeUsage(usage, first.addedIds);
  assert.equal(deduped.totals.input, 0);
  assert.equal(gradeFor({ firstInputTokens: 1, lastInputTokens: 11, turnCount: 81, responseTimes: [21_000, 21_000, 21_000], opusLowOutputCount: 3 }).grade, 'D');
  assert.equal(gradeFor({ firstInputTokens: 1, lastInputTokens: 1, turnCount: 5, responseTimes: [], opusLowOutputCount: 0 }).grade, 'A+');
});
test('exact authorization skips malformed prompt ids, expired records, and compact or failed barriers', () => {
  const home = temp('prism-realtime-guards-home-');
  const data = temp('prism-realtime-guards-data-');
  const file = path.join(home, 'turn.jsonl');
  const promptId = 'guard-prompt';
  const text = 'guard reply';
  fs.writeFileSync(file, transcript(promptId, text, [{ input: 1, output: 1, model: 'claude-sonnet-4-6' }]));
  process.env.CLAUDE_PLUGIN_DATA = data;

  for (const [id, stopPrompt] of [['missing', undefined], ['mismatch', 'other'], ['non-string', 9]]) {
    active(id, promptId, file);
    const result = spawnSync(process.execPath, [STOP], {
      cwd: ROOT,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: id, prompt_id: stopPrompt, transcript_path: file, last_assistant_message: text }),
      env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data },
    });
    assert.equal(result.stdout, '');
    assert.equal(session.readTurn(id).active.status, 'captured');
  }

  active('expired', promptId, file, new Date(Date.now() - 31 * 60 * 1000).toISOString());
  assert.equal(spawnSync(process.execPath, [STOP], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'expired', prompt_id: promptId, transcript_path: file, last_assistant_message: text }),
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data },
  }).stdout, '');
  assert.equal(session.readTurn('expired').active.status, 'captured');

  active('compact', promptId, file);
  session.advanceCompactBarrier('compact');
  assert.equal(session.readTurn('compact').active.status, 'invalidated');
  const failed = session.advanceBarrier('failed-new-normal', 'normal-pending');
  assert.ok(session.attachActive('failed-new-normal', {
    epoch: failed.epoch,
    clientEventId: 'failed-event',
    submitPromptId: promptId,
    submittedAt: new Date().toISOString(),
    transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
    frozenPayloadHash: crypto.createHash('sha256').update('failed').digest('hex'),
    status: 'submitting',
  }));
  assert.ok(session.failBarrier('failed-new-normal', failed.epoch));
  assert.equal(session.advanceBarrier('failed-new-normal', 'normal-pending').kind, 'normal-pending');
});

test('showRealtimeSummary off suppresses stdout but retains exact capture and summary', () => {
  const home = temp('prism-realtime-off-home-');
  const data = temp('prism-realtime-off-data-');
  const file = path.join(home, 'turn.jsonl');
  const marker = path.join(home, 'response.json');
  const promptId = 'off-prompt';
  const text = 'off reply';
  fs.writeFileSync(file, transcript(promptId, text, [{ input: 10, output: 2, model: 'claude-sonnet-4-6' }]));
  process.env.CLAUDE_PLUGIN_DATA = data;
  active('summary-off', promptId, file);
  const result = spawnSync(process.execPath, [STOP], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'summary-off', prompt_id: promptId, transcript_path: file, last_assistant_message: text }),
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data, PRISM_API_KEY: 'prism_test', PRISM_INGEST_URL: 'http://127.0.0.1:9', RESPONSE_MARKER: marker, CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'false', NODE_OPTIONS: `--require=${interceptor(home)}` },
  });
  assert.equal(result.stdout, '');
  assert.equal(session.readTurn('summary-off').active.status, 'consumed');
  assert.equal(session.readSummary('summary-off').contextHealth.turnCount, 1);
  assert.equal(fs.existsSync(marker), true);
});
test('oversized boundaries fail closed, while structural proof rejects later users and ignores sidechains', async () => {
  const dir = temp('prism-realtime-boundary-');
  const oversized = path.join(dir, 'oversized.jsonl');
  fs.writeFileSync(oversized, `${'x'.repeat(MAX_TRANSCRIPT_BYTES + 1)}\n${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`);
  assert.equal(await proveTranscriptTurn({ transcriptPath: oversized, boundary: { byteOffset: 0 }, promptId: 'host' }), null);
  const data = temp('prism-realtime-oversize-data-');
  process.env.CLAUDE_PLUGIN_DATA = data;
  active('oversized-stop', 'host', oversized);
  const stop = spawnSync(process.execPath, [STOP], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'oversized-stop', prompt_id: 'host', transcript_path: oversized, last_assistant_message: 'answer' }),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(session.readTurn('oversized-stop').active.status, 'captured');

  const sidechain = JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', isSidechain: true, stop_reason: 'end_turn', content: 'x'.repeat(900_000), usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  const validAssistant = JSON.stringify({ type: 'assistant', uuid: 'top-level', message: { role: 'assistant', stop_reason: 'end_turn', content: 'answer', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  const structural = path.join(dir, 'structural.jsonl');
  fs.writeFileSync(structural, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'request' } })}\n${sidechain}\n${validAssistant}\n`);
  assert.equal((await proveTranscriptTurn({ transcriptPath: structural, boundary: { byteOffset: 0 }, promptId: 'host' })).usage.length, 1);
  fs.writeFileSync(structural, `${JSON.stringify({ type: 'user', prompt_id: 'other', message: { role: 'user' } })}\n${validAssistant}\n`);
  assert.equal(await proveTranscriptTurn({ transcriptPath: structural, boundary: { byteOffset: 0 }, promptId: 'host' }), null);
  fs.writeFileSync(structural, `${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n${validAssistant}\n${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`);
  assert.equal(await proveTranscriptTurn({ transcriptPath: structural, boundary: { byteOffset: 0 }, promptId: 'host' }), null);
});

test('usage identities ignore mutable values and pricing charges all four token buckets', async () => {
  const cached = consumeUsage([{
    id: 'a'.repeat(64), input: 100, cacheRead: 50, cacheCreation: 25, output: 10, model: 'claude-sonnet-4-6',
  }], []);
  assert.equal(cached.totals.cost, (100 * 3 + 50 * 0.3 + 25 * 3.75 + 10 * 15) / 1_000_000);
  const unlisted = consumeUsage([{
    id: 'b'.repeat(64), input: 1, cacheRead: 0, cacheCreation: 0, output: 1, model: 'claude-opus-experimental',
  }], []);
  assert.equal(unlisted.totals.unknownCost, true);
  assert.equal(unlisted.totals.cost, 0);

  const dir = temp('prism-realtime-identity-');
  const file = path.join(dir, 'identity.jsonl');
  const record = (output) => `${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n${JSON.stringify({ type: 'assistant', uuid: 'mutable-uuid', message: { id: 'verified-message-id', role: 'assistant', stop_reason: 'end_turn', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output } } })}\n`;
  fs.writeFileSync(file, record(1));
  const first = await proveTranscriptTurn({ transcriptPath: file, boundary: { byteOffset: 0 } });
  fs.writeFileSync(file, record(999));
  const replay = await proveTranscriptTurn({ transcriptPath: file, boundary: { byteOffset: 0 } });
  const consumed = consumeUsage(first.usage, []);
  assert.equal(consumeUsage(replay.usage, consumed.addedIds).totals.output, 0);
});
test('Lite rubric uses strict growth, turn, latency, and opus thresholds', () => {
  const base = { firstInputTokens: 1, lastInputTokens: 1, turnCount: 20, responseTimes: [], opusLowOutputCount: 2 };
  assert.equal(gradeFor({ ...base, lastInputTokens: 3 }).score, 10);
  assert.equal(gradeFor({ ...base, lastInputTokens: 4 }).score, 8.5);
  assert.equal(gradeFor({ ...base, lastInputTokens: 10 }).score, 8.5);
  assert.equal(gradeFor({ ...base, lastInputTokens: 11 }).score, 7);
  assert.equal(gradeFor({ ...base, turnCount: 21 }).score, 9.5);
  assert.equal(gradeFor({ ...base, turnCount: 80 }).score, 9.5);
  assert.equal(gradeFor({ ...base, turnCount: 81 }).score, 8);
  assert.equal(gradeFor({ ...base, responseTimes: [20_000, 20_000, 20_000] }).score, 10);
  assert.equal(gradeFor({ ...base, responseTimes: [20_001, 20_001, 20_001] }).score, 9);
  assert.equal(gradeFor({ ...base, opusLowOutputCount: 3 }).score, 9.5);
  assert.deepEqual(
    [
      base,
      { ...base, responseTimes: [20_001, 20_001, 20_001] },
      { ...base, lastInputTokens: 4 },
      { ...base, lastInputTokens: 4, turnCount: 21 },
      { ...base, lastInputTokens: 11 },
      { ...base, lastInputTokens: 11, turnCount: 21 },
      { ...base, lastInputTokens: 11, responseTimes: [20_001, 20_001, 20_001] },
      { ...base, lastInputTokens: 11, turnCount: 81 },
      { ...base, lastInputTokens: 11, turnCount: 81, responseTimes: [20_001, 20_001, 20_001] },
    ].map((health) => gradeFor(health).grade),
    ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'D'],
  );
});
test('concurrent Stop hooks have exactly one compare-and-swap winner', async () => {
  const home = temp('prism-realtime-cas-home-');
  const data = temp('prism-realtime-cas-data-');
  const file = path.join(home, 'turn.jsonl');
  const promptId = 'concurrent-prompt';
  const text = 'concurrent answer';
  fs.writeFileSync(file, transcript(promptId, text, [{ input: 1, output: 1, model: 'claude-sonnet-4-6' }]));
  process.env.CLAUDE_PLUGIN_DATA = data;
  active('concurrent-stop', promptId, file);
  const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'true' };
  delete env.PRISM_API_KEY;
  delete env.PRISM_GCK_KEY;
  delete env.PRISM_INGEST_URL;
  const invoke = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [STOP], { cwd: ROOT, env });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify({ session_id: 'concurrent-stop', prompt_id: promptId, transcript_path: file, last_assistant_message: text }));
    child.on('close', (code) => resolve({ code, stdout }));
  });
  const results = await Promise.all([invoke(), invoke()]);
  assert.deepEqual(results.map((result) => result.code), [0, 0]);
  assert.equal(results.filter((result) => result.stdout.includes('Realtime summary unavailable')).length, 1);
  assert.equal(session.readTurn('concurrent-stop').active.status, 'consumed');
});

test('the pricing allowlist matches the official per-model four-bucket rates', () => {
  const expected = {
    'claude-fable-5': [10, 12.5, 1, 50],
    'claude-mythos-5': [10, 12.5, 1, 50],
    'claude-opus-4-8': [5, 6.25, 0.5, 25],
    'claude-opus-4-7': [5, 6.25, 0.5, 25],
    'claude-opus-4-6': [5, 6.25, 0.5, 25],
    'claude-opus-4-5': [5, 6.25, 0.5, 25],
    'claude-opus-4-5-20251101': [5, 6.25, 0.5, 25],
    'claude-sonnet-5': [2, 2.5, 0.2, 10],
    'claude-sonnet-4-6': [3, 3.75, 0.3, 15],
    'claude-sonnet-4-5': [3, 3.75, 0.3, 15],
    'claude-sonnet-4-5-20250929': [3, 3.75, 0.3, 15],
    'claude-haiku-4-5': [1, 1.25, 0.1, 5],
    'claude-haiku-4-5-20251001': [1, 1.25, 0.1, 5],
    'claude-opus-4-1-20250805': [15, 18.75, 1.5, 75],
  };
  for (const [model, [input, cacheWrite, cacheRead, output]] of Object.entries(expected)) {
    const pricing = pricingFor(model, () => Date.UTC(2026, 7, 31, 23, 59, 59, 999));
    assert.ok(pricing, `missing pricing for ${model}`);
    assert.deepEqual(
      [pricing.input, pricing.cacheWrite, pricing.cacheRead, pricing.output],
      [input, cacheWrite, cacheRead, output],
      model,
    );
  }
  assert.deepEqual(
    pricingFor('claude-sonnet-5', () => Date.UTC(2026, 8, 1)),
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  );
  // Long-context marker normalizes to the same standard rates.
  assert.deepEqual(pricingFor('claude-opus-4-8[1m]'), pricingFor('claude-opus-4-8'));
  // No family fallback for unlisted snapshots.
  assert.equal(pricingFor('claude-opus-4-5-20250514'), null);
  assert.equal(pricingFor('claude-opus-9'), null);
  assert.equal(isOpusModel('claude-opus-4-8[1m]'), true);
  assert.equal(isOpusModel('claude-sonnet-4-6'), false);
});

test('duplicate usage identities increment the opus rubric signal only once', async () => {
  const home = temp('prism-realtime-opus-home-');
  const data = temp('prism-realtime-opus-data-');
  const file = path.join(home, 'turn.jsonl');
  const promptId = 'opus-dup-prompt';
  const text = 'short';
  const usage = { input: 10, output: 10, model: 'claude-opus-4-8' };
  const shared = {
    type: 'assistant',
    message: {
      id: 'msg-shared', role: 'assistant', stop_reason: 'end_turn', content: text, model: usage.model,
      usage: { input_tokens: usage.input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: usage.output },
    },
  };
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', prompt_id: promptId, message: { role: 'user', content: 'request' } }),
    JSON.stringify(shared),
    JSON.stringify(shared),
  ].join('\n') + '\n');
  process.env.CLAUDE_PLUGIN_DATA = data;
  active('opus-dup', promptId, file);
  const marker = path.join(home, 'response.json');
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'false',
    PRISM_API_KEY: 'prism_test',
    PRISM_INGEST_URL: 'http://127.0.0.1:9',
    RESPONSE_MARKER: marker,
    NODE_OPTIONS: `--require=${interceptor(home)}`,
  };
  const result = spawnSync(process.execPath, [STOP], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'opus-dup', prompt_id: promptId, transcript_path: file, last_assistant_message: text }),
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = session.readSummary('opus-dup');
  assert.equal(summary.contextHealth.opusLowOutputCount, 1);
  assert.equal(summary.consumedTotals.input, 10);
});

test('an explicitly present falsey transcript prompt id is a mismatch, not an absence', async () => {
  const home = temp('prism-realtime-falsey-home-');
  const promptId = 'falsey-prompt';
  const file = path.join(home, 'turn.jsonl');
  const record = (userLine) => [
    userLine,
    JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', stop_reason: 'end_turn', content: 'ok', model: 'claude-sonnet-4-6', usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
  ].join('\n') + '\n';

  fs.writeFileSync(file, record(JSON.stringify({ type: 'user', prompt_id: '', message: { role: 'user', content: 'request' } })));
  assert.equal(await proveTranscriptTurn({ transcriptPath: file, boundary: { byteOffset: 0 }, promptId }), null);

  fs.writeFileSync(file, record(JSON.stringify({ type: 'user', message: { role: 'user', content: 'request' } })));
  assert.ok(await proveTranscriptTurn({ transcriptPath: file, boundary: { byteOffset: 0 }, promptId }));
});
