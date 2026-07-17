const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SUBMIT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'submit-handler.js');
const SESSION_START = path.join(ROOT, 'hooks', 'scripts', 'session-start.sh');
const STOP_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'stop-handler.js');
const SENTINEL = 'prism_submit_handler_secret_sentinel';
const tempDirs = [];
const session = require('../lib/session');
const PREFLIGHT_FIXTURE = JSON.parse(fs.readFileSync(
  path.resolve(ROOT, '..', 'artifacts', 'preflight-fixture.json'),
  'utf8',
));

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readAllFiles(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? readAllFiles(entryPath) : fs.readFileSync(entryPath, 'utf8');
  }).join('');
}

function turnFile(dataDir, sessionId) {
  const hash = crypto.createHash('sha256').update(sessionId).digest('hex');
  const dir = path.join(dataDir, 'runtime', 'sessions', hash);
  const files = fs.readdirSync(dir)
    .filter((file) => /^turn\.g\d+\.f\d+\.json$/.test(file))
    .sort((left, right) => {
      const leftParts = left.match(/\.g(\d+)\.f(\d+)\.json$/);
      const rightParts = right.match(/\.g(\d+)\.f(\d+)\.json$/);
      return Number(leftParts[2]) - Number(rightParts[2]) || Number(leftParts[1]) - Number(rightParts[1]);
    });
  return path.join(dir, files.at(-1));
}

function seedActive(dataDir, sessionId) {
  const original = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const barrier = session.advanceBarrier(sessionId, 'normal-pending');
    session.attachActive(sessionId, {
      epoch: barrier.epoch,
      clientEventId: 'prior-client-event',
      submittedAt: new Date().toISOString(),
      transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
      frozenPayloadHash: crypto.createHash('sha256').update('prior').digest('hex'),
      status: 'submitting',
    });
  } finally {
    if (original === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = original;
  }
}
function assertJsonOrEmpty(stdout) {
  if (stdout === '') return null;
  assert.match(stdout, /^\{.*\}\n$/s);
  return JSON.parse(stdout);
}

function seedContextHealth(dataDir, sessionId, contextHealth) {
  const original = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    assert.ok(session.updateSummary(sessionId, (summary) => ({
      ...summary,
      contextHealth: { ...summary.contextHealth, ...contextHealth },
    })));
  } finally {
    if (original === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = original;
  }
}
function readSessionRecord(dataDir, reader) {
  const original = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return reader();
  } finally {
    if (original === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = original;
  }
}

function writeSuccessfulIngestInterceptor(home) {
  const interceptor = path.join(home, 'successful-ingest.js');
  fs.writeFileSync(interceptor, [
    "const events = require('node:events');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  const request = new events.EventEmitter();',
    '  request.write = () => {};',
    '  request.destroy = () => {};',
    '  request.end = () => {',
    '    const response = new events.EventEmitter();',
    "    response.statusCode = url.pathname === '/v1/prompts' ? 201 : 202;",
    '    callback(response);',
    "    if (url.pathname === '/v1/prompts') response.emit('data', Buffer.from('{\"id\":\"server-prompt-id\"}'));",
    "    response.emit('end');",
    '  };',
    '  return request;',
    '};',
    '',
  ].join('\n'));
  return interceptor;
}

function runSessionStart(home, dataDir, input, env = {}) {
  return spawnSync('bash', [SESSION_START], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_PLUGIN_ROOT: ROOT,
      ...env,
    },
    timeout: 3000,
  });
}

function assertLifecycleInvalidated(dataDir, sessionId) {
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, sessionId), 'utf8'));
  assert.equal(turn.epoch, 2);
  assert.equal(turn.kind, 'lifecycle');
  assert.equal(turn.active.status, 'invalidated');
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('/prism control prompts only create an opaque control barrier', () => {
  const home = makeTempDir('prism-hook-home-');
  const dataDir = makeTempDir('prism-hook-data-');
  const env = { ...process.env };
  for (const key of ['PRISM_API_KEY', 'PRISM_GCK_KEY', 'CLAUDE_PLUGIN_OPTION_apiKey', 'PRISM_DEBUG']) delete env[key];
  const fetchMarker = path.join(home, 'fetch-called');
  const fetchBlocker = path.join(home, 'block-fetch.js');
  fs.writeFileSync(fetchBlocker, [
    "const fs = require('node:fs');",
    'global.fetch = async () => {',
    "  fs.writeFileSync(process.env.PRISM_FETCH_MARKER, 'called');",
    "  throw new Error('fetch blocked');",
    '};',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'control-session', cwd: ROOT, prompt: `/prism:setup ${SENTINEL}` }),
    env: {
      ...env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      PRISM_API_KEY: 'prism_1234567890abcdef',
      PRISM_DEBUG: '1',
      PRISM_FETCH_MARKER: fetchMarker,
      NODE_OPTIONS: `--require=${fetchBlocker}`,
    },
    timeout: 1000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
  assert.doesNotMatch(result.stderr, new RegExp(SENTINEL));
  assert.equal(readAllFiles(home).includes(SENTINEL), false);
  assert.equal(readAllFiles(dataDir).includes(SENTINEL), false);
  assert.equal(fs.existsSync(path.join(home, '.prism', 'advisor-context.json')), false);
  assert.equal(fs.existsSync(fetchMarker), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'debug.log')), false);
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'control-session'), 'utf8'));
  assert.equal(turn.kind, 'control');
  assert.equal(turn.epoch, 1);
  assert.equal(turn.active, null);
  assert.equal(JSON.stringify(turn).includes(SENTINEL), false);
});

test('SessionStart advances lifecycle barriers before missing and invalid key exits', () => {
  for (const [label, config] of [
    ['missing', {}],
    ['invalid', { CLAUDE_PLUGIN_OPTION_apiKey: 'invalid-key' }],
  ]) {
    const home = makeTempDir(`prism-session-start-${label}-home-`);
    const dataDir = makeTempDir(`prism-session-start-${label}-data-`);
    const sessionId = `${label}-key-session`;
    seedActive(dataDir, sessionId);
    const result = runSessionStart(home, dataDir, { session_id: sessionId, source: 'startup' }, config);
    assert.equal(result.status, 0, result.stderr);
    assertLifecycleInvalidated(dataDir, sessionId);
  }
});

test('SessionStart advances lifecycle barriers before config auth rejection exit', () => {
  const home = makeTempDir('prism-session-start-auth-home-');
  const dataDir = makeTempDir('prism-session-start-auth-data-');
  const sessionId = 'auth-rejected-session';
  const apiKey = 'prism_auth_rejected_key';
  seedActive(dataDir, sessionId);
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config-cache.json'), JSON.stringify({
    ingest_url: 'https://ingest.example.test',
    cached_at: new Date().toISOString(),
    source: 'auth-error',
    auth_status: 401,
    api_key_fingerprint: crypto.createHash('sha256').update(apiKey).digest('hex'),
  }));

  const result = runSessionStart(home, dataDir, { session_id: sessionId, source: 'startup' }, {
    CLAUDE_PLUGIN_OPTION_apiKey: apiKey,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /rejected/);
  assertLifecycleInvalidated(dataDir, sessionId);
});

test('normal prompts bind the captured server id to an opaque frozen payload', () => {
  const home = makeTempDir('prism-normal-home-');
  const dataDir = makeTempDir('prism-normal-data-');
  const transcript = path.join(home, 'transcript.jsonl');
  const marker = path.join(home, 'prompt.json');
  const interceptor = path.join(home, 'prompt-interceptor.js');
  const prompt = 'normal prompt that must not be persisted';
  fs.writeFileSync(transcript, 'first\nsecond\n');
  fs.truncateSync(transcript, 64 * 1024 * 1024);
  fs.writeFileSync(interceptor, [
    "const events = require('node:events');",
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  let body = "";',
    '  const request = new events.EventEmitter();',
    '  request.write = (chunk) => { body += chunk; };',
    '  request.destroy = () => {};',
    '  request.end = () => {',
    "    if (url.pathname === '/v1/prompts') fs.writeFileSync(process.env.PRISM_PROMPT_MARKER, body);",
    '    const response = new events.EventEmitter();',
    '    response.statusCode = 201;',
    '    callback(response);',
    "    response.emit('data', Buffer.from('{\"id\":\"server-prompt-id\"}'));",
    "    response.emit('end');",
    '  };',
    '  return request;',
    '};',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'normal-capture-session',
      cwd: ROOT,
      prompt,
      transcript_path: transcript,
      prompt_id: 'submit-host-prompt-id',
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_normal_capture',
      PRISM_INGEST_URL: 'http://127.0.0.1:12345',
      PRISM_PROMPT_MARKER: marker,
      NODE_OPTIONS: `--require=${interceptor}`,
    },
    timeout: 3000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  const sent = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'normal-capture-session'), 'utf8'));
  assert.equal(turn.kind, 'normal-pending');
  assert.equal(turn.active.status, 'captured');
  assert.equal(turn.active.clientEventId, sent.client_event_id);
  assert.equal(turn.active.submitPromptId, 'submit-host-prompt-id');
  assert.deepEqual(Object.keys(sent.metadata.git).sort(), [
    'branch', 'dirty', 'head', 'host', 'owner', 'repo', 'worktree',
  ]);
  assert.equal(typeof sent.metadata.git.dirty, 'boolean');
  assert.match(sent.metadata.git.head, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(turn.active.transcriptBoundary, { byteOffset: 64 * 1024 * 1024, lineOffset: 0 });
  assert.equal(turn.active.frozenPayloadHash, crypto.createHash('sha256').update(JSON.stringify(sent)).digest('hex'));
  assert.equal(JSON.stringify(turn).includes(prompt), false);
});
test('Stop without an exact captured prompt is a zero-effect skip', () => {
  const home = makeTempDir('prism-stop-home-');
  const dataDir = makeTempDir('prism-stop-data-');
  const result = spawnSync(process.execPath, [STOP_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'uncorrelated-stop-session',
      last_assistant_message: 'unmatched response',
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_stop_handler_test',
      PRISM_INGEST_URL: 'http://127.0.0.1:12345',
    },
    timeout: 3000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
test('control classification finishes stdin parsing before loading plugin modules', () => {
  const home = makeTempDir('prism-bootstrap-home-');
  const dataDir = makeTempDir('prism-bootstrap-data-');
  const marker = path.join(home, 'early-module-load');
  const hook = path.join(home, 'require-order-hook.js');
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    "const Module = require('node:module');",
    'const on = process.stdin.on.bind(process.stdin);',
    "process.stdin.on = (event, listener) => event === 'end'",
    "  ? on(event, (...args) => { global.__prismStdinEnded = true; listener(...args); })",
    '  : on(event, listener);',
    'const load = Module._load;',
    'Module._load = function(request, parent, isMain) {',
    "  if (request.includes('/lib/') && !global.__prismStdinEnded) fs.appendFileSync(process.env.PRISM_REQUIRE_MARKER, request + '\\n');",
    '  return load.call(this, request, parent, isMain);',
    '};',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'bootstrap-control', prompt: ' \t/prism:setup prism_key' }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_REQUIRE_MARKER: marker,
      NODE_OPTIONS: `--require=${hook}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  assert.equal(fs.existsSync(marker), false);
});

test('unexpected post-attach failures advance the same epoch to failed', () => {
  const home = makeTempDir('prism-post-attach-home-');
  const dataDir = makeTempDir('prism-post-attach-data-');
  const hook = path.join(home, 'fail-env-load.js');
  fs.writeFileSync(hook, [
    "const Module = require('node:module');",
    'const load = Module._load;',
    'Module._load = function(request, parent, isMain) {',
    "  if (request === '../../lib/env' && parent && parent.filename.endsWith('submit-handler.js')) throw new Error('injected env load failure');",
    '  return load.call(this, request, parent, isMain);',
    '};',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'post-attach-session', prompt: 'a normal prompt for failure injection' }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_post_attach',
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      NODE_OPTIONS: `--require=${hook}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'post-attach-session'), 'utf8'));
  assert.equal(turn.epoch, 1);
  assert.equal(turn.kind, 'failed');
  assert.equal(turn.active, null);
});

test('SessionStart advances lifecycle barriers with missing HOME and fallback plugin root', () => {
  const dataDir = makeTempDir('prism-session-start-fallback-data-');
  const sessionId = 'fallback-root-session';
  seedActive(dataDir, sessionId);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir };
  delete env.HOME;
  delete env.CLAUDE_PLUGIN_ROOT;

  const result = spawnSync('bash', [SESSION_START], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId, source: 'startup' }),
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assertLifecycleInvalidated(dataDir, sessionId);
});
test('submit refuses promotion when a successful response has no persisted server id', () => {
  const home = makeTempDir('prism-submit-nil-id-home-');
  const dataDir = makeTempDir('prism-submit-nil-id-data-');
  const hook = path.join(home, 'nil-id-interceptor.js');
  fs.writeFileSync(hook, [
    "const events = require('node:events');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  const request = new events.EventEmitter(); request.write = () => {}; request.destroy = () => {};',
    '  request.end = () => { const response = new events.EventEmitter(); response.statusCode = 201; callback(response); response.emit("data", Buffer.from(\'{"id":null}\')); response.emit("end"); };',
    '  return request;',
    '};',
  ].join('\n'));
  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'nil-server-id', prompt_id: 'host-prompt', prompt: 'capture this' }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_submit_nil_id',
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      NODE_OPTIONS: `--require=${hook}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'nil-server-id'), 'utf8'));
  assert.equal(turn.kind, 'failed');
  assert.equal(turn.active, null);
});
test('submit uses JSON system messages for missing configuration and suppresses them when disabled', () => {
  const home = makeTempDir('prism-submit-config-home-');
  const dataDir = makeTempDir('prism-submit-config-data-');
  const input = { session_id: 'missing-config', prompt: 'normal prompt' };
  const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: dataDir };
  for (const key of ['PRISM_API_KEY', 'PRISM_GCK_KEY', 'CLAUDE_PLUGIN_OPTION_apiKey', 'PRISM_DEBUG']) delete env[key];

  const shown = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env,
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stderr, '');
  assert.deepEqual(assertJsonOrEmpty(shown.stdout), {
    systemMessage: '[Prism] API key not configured. Run /prism:setup prism_YOUR_KEY.',
  });

  const hidden = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ ...input, session_id: 'missing-config-off' }),
    env: { ...env, CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'false' },
  });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stderr, '');
  assert.equal(assertJsonOrEmpty(hidden.stdout), null);
});

test('submit context nudges use strict Lite growth and turn boundaries and remain JSON-only', () => {
  const home = makeTempDir('prism-submit-nudge-home-');
  const dataDir = makeTempDir('prism-submit-nudge-data-');
  const interceptor = writeSuccessfulIngestInterceptor(home);
  const cases = [
    { label: 'growth-3', health: { firstInputTokens: 1, lastInputTokens: 3, turnCount: 0 }, message: null },
    { label: 'growth-over-3', health: { firstInputTokens: 100, lastInputTokens: 301, turnCount: 0 }, message: /run \/compact/ },
    { label: 'growth-10', health: { firstInputTokens: 1, lastInputTokens: 10, turnCount: 0 }, message: /run \/compact/ },
    { label: 'growth-over-10', health: { firstInputTokens: 100, lastInputTokens: 1001, turnCount: 0 }, message: /consider \/clear/ },
    { label: 'turn-80', health: { firstInputTokens: 1, lastInputTokens: 1, turnCount: 80 }, message: null },
    { label: 'turn-over-80', health: { firstInputTokens: 1, lastInputTokens: 1, turnCount: 81 }, message: /consider \/clear/ },
  ];

  for (const { label, health, message } of cases) {
    const sessionId = `nudge-${label}`;
    seedContextHealth(dataDir, sessionId, health);
    const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
      cwd: ROOT,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: sessionId,
        prompt_id: `host-${label}`,
        prompt: 'normal prompt',
      }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_DATA: dataDir,
        PRISM_API_KEY: 'prism_nudge_test',
        PRISM_INGEST_URL: 'http://127.0.0.1:9',
        NODE_OPTIONS: `--require=${interceptor}`,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const output = assertJsonOrEmpty(result.stdout);
    if (message) assert.match(output.systemMessage, message);
    else assert.equal(output, null);
  }
});

test('submit suppresses display nudges while retaining capture when realtime summaries are off', () => {
  const home = makeTempDir('prism-submit-off-home-');
  const dataDir = makeTempDir('prism-submit-off-data-');
  const sessionId = 'submit-nudge-off';
  seedContextHealth(dataDir, sessionId, { firstInputTokens: 1, lastInputTokens: 11, turnCount: 0 });
  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId, prompt_id: 'host-off', prompt: 'normal prompt' }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_off_test',
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'false',
      NODE_OPTIONS: `--require=${writeSuccessfulIngestInterceptor(home)}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  assert.equal(readSessionRecord(dataDir, () => session.readTurn(sessionId)).active.status, 'captured');
});

test('real-host fixture completes submit-to-stop correlation without leaking prompt content', () => {
  const home = makeTempDir('prism-host-lifecycle-home-');
  const dataDir = makeTempDir('prism-host-lifecycle-data-');
  const transcript = path.join(home, 'transcript.jsonl');
  const fixture = structuredClone(PREFLIGHT_FIXTURE);
  const sentinelPrompt = `${fixture.userPromptSubmit.prompt} ${SENTINEL}`;
  fs.writeFileSync(transcript, '');
  fixture.userPromptSubmit.prompt = sentinelPrompt;
  fixture.userPromptSubmit.transcript_path = transcript;
  fixture.userPromptSubmit.cwd = ROOT;
  fixture.stop.transcript_path = transcript;
  fixture.stop.cwd = ROOT;
  const interceptor = writeSuccessfulIngestInterceptor(home);
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    PRISM_API_KEY: 'prism_host_fixture',
    PRISM_INGEST_URL: 'http://127.0.0.1:9',
    NODE_OPTIONS: `--require=${interceptor}`,
  };

  const submit = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(fixture.userPromptSubmit),
    env,
  });
  assert.equal(submit.status, 0, submit.stderr);
  assert.equal(submit.stderr, '');
  assert.equal(assertJsonOrEmpty(submit.stdout), null);
  assert.equal(readAllFiles(dataDir).includes(SENTINEL), false);

  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', prompt_id: fixture.stop.prompt_id, message: { role: 'user', content: 'request' } }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'fixture-assistant',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: fixture.stop.last_assistant_message,
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 },
      },
    }),
    '',
  ].join('\n'));
  const stop = spawnSync(process.execPath, [STOP_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(fixture.stop),
    env,
  });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stderr, '');
  assert.match(assertJsonOrEmpty(stop.stdout).systemMessage, /^\[Prism\] Lite /);
  assert.equal(readSessionRecord(dataDir, () => session.readTurn(fixture.stop.session_id)).active.status, 'consumed');
  assert.equal(readSessionRecord(dataDir, () => session.readSummary(fixture.stop.session_id)).contextHealth.turnCount, 1);
  assert.equal(readAllFiles(home).includes(SENTINEL), false);
  assert.equal(readAllFiles(dataDir).includes(SENTINEL), false);
});
