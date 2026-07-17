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
  const sent = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'normal-capture-session'), 'utf8'));
  assert.equal(turn.kind, 'normal-pending');
  assert.equal(turn.active.status, 'captured');
  assert.equal(turn.active.clientEventId, sent.client_event_id);
  assert.equal(turn.active.submitPromptId, 'submit-host-prompt-id');
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
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'nil-server-id'), 'utf8'));
  assert.equal(turn.kind, 'failed');
  assert.equal(turn.active, null);
});
