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
  path.resolve(ROOT, 'test', 'fixtures', 'preflight-fixture.json'),
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
  const realtimeRows = JSON.stringify([{
    sub_session_id: 'live-sub-session',
    is_preview: true,
    substance_floor_passed: true,
    letter_grade: 'B',
    intent_class: 'refactor',
    started_at: '2000-01-01T00:00:00.000Z',
  }]);
  fs.writeFileSync(interceptor, [
    "const events = require('node:events');",
    "const http = require('node:http');",
    `const realtimeRows = ${JSON.stringify(realtimeRows)};`,
    'http.request = (url, options, callback) => {',
    '  const request = new events.EventEmitter();',
    '  request.write = () => {};',
    '  request.destroy = () => {};',
    '  request.end = () => {',
    '    const response = new events.EventEmitter();',
    "    if (url.pathname === '/v1/score_v3/realtime/sub-sessions') { response.statusCode = 200; callback(response); response.emit('data', Buffer.from(realtimeRows)); response.emit('end'); return; }",
    "    response.statusCode = url.pathname === '/v1/prompts' ? 201 : 202;",
    '    callback(response);',
    "    if (url.pathname === '/v1/prompts') response.emit('data', Buffer.from('{\"id\":\"5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f\"}'));",
    "    response.emit('end');",
    '  };',
    '  return request;',
    '};',
    '',
  ].join('\n'));
  return interceptor;
}
function writePostInterceptor(home) {
  const interceptor = path.join(home, 'post-interceptor.js');
  fs.writeFileSync(interceptor, [
    "const events = require('node:events');",
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    "  fs.appendFileSync(process.env.PRISM_POST_MARKER, `${url.pathname}\\n`);",
    '  const request = new events.EventEmitter();',
    '  request.write = () => {};',
    '  request.destroy = () => {};',
    '  request.end = () => {};',
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
test('case-insensitive and whitespace-prefixed Prism controls never post', () => {
  for (const prompt of [
    '/PRISM:setup sk-secret',
    '\u0000/prism:setup sk-secret',
    '\u00A0/PRISM:config x',
  ]) {
    const home = makeTempDir('prism-control-home-');
    const dataDir = makeTempDir('prism-control-data-');
    const postMarker = path.join(home, 'posts');
    const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
      cwd: ROOT,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: `control-${Buffer.from(prompt).toString('hex')}`, prompt }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_DATA: dataDir,
        PRISM_API_KEY: 'prism_control_test',
        PRISM_INGEST_URL: 'http://127.0.0.1:12345',
        PRISM_POST_MARKER: postMarker,
        NODE_OPTIONS: `--require=${writePostInterceptor(home)}`,
      },
      timeout: 1000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(postMarker), false);
    const turn = JSON.parse(fs.readFileSync(
      turnFile(dataDir, `control-${Buffer.from(prompt).toString('hex')}`),
      'utf8',
    ));
    assert.equal(turn.kind, 'control');
    assert.equal(turn.active, null);
  }
});

test('non-string prompts advance only control barriers without posting', () => {
  for (const [label, prompt] of [
    ['number', 42],
    ['object', { secret: SENTINEL }],
    ['null', null],
    ['missing', undefined],
  ]) {
    const home = makeTempDir(`prism-${label}-prompt-home-`);
    const dataDir = makeTempDir(`prism-${label}-prompt-data-`);
    const sessionId = `${label}-prompt-session`;
    const postMarker = path.join(home, 'posts');
    const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
      cwd: ROOT,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: sessionId, prompt }),
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_DATA: dataDir,
        PRISM_API_KEY: 'prism_nonstring_test',
        PRISM_INGEST_URL: 'http://127.0.0.1:12345',
        PRISM_POST_MARKER: postMarker,
        NODE_OPTIONS: `--require=${writePostInterceptor(home)}`,
      },
      timeout: 1000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(postMarker), false);
    const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, sessionId), 'utf8'));
    assert.equal(turn.kind, 'control');
    assert.equal(turn.active, null);
    assert.equal(JSON.stringify(turn).includes(SENTINEL), false);
  }
});
test('SessionStart resolves official uppercase API key and threshold userConfig values', () => {
  const home = makeTempDir('prism-session-start-uppercase-home-');
  const dataDir = makeTempDir('prism-session-start-uppercase-data-');
  const envFile = path.join(home, 'session-env');
  const apiKey = 'prism_uppercase_session';
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config-cache.json'), JSON.stringify({
    ingest_url: 'https://ingest.example.test',
    dashboard_url: 'https://dashboard.example.test',
    source: 'cache',
    cached_at: new Date().toISOString(),
    api_key_fingerprint: crypto.createHash('sha256').update(apiKey).digest('hex'),
  }));

  const result = runSessionStart(home, dataDir, {
    session_id: 'uppercase-session',
    source: 'startup',
  }, {
    PRISM_API_KEY: '',
    PRISM_GCK_KEY: '',
    PRISM_THRESHOLD: '',
    CLAUDE_PLUGIN_OPTION_APIKEY: apiKey,
    CLAUDE_PLUGIN_OPTION_apiKey: '',
    CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD: '6.5',
    CLAUDE_PLUGIN_OPTION_prismThreshold: '',
    CLAUDE_ENV_FILE: envFile,
  });

  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(envFile, 'utf8');
  assert.match(written, /export PRISM_API_KEY=prism_uppercase_session/);
  assert.match(written, /export PRISM_THRESHOLD=6\.5/);
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
    "    response.emit('data', Buffer.from('{\"id\":\"5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f\"}'));",
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
  assert.equal(turn.active.serverPromptId, '5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f');
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
  for (const key of ['PRISM_API_KEY', 'PRISM_GCK_KEY', 'CLAUDE_PLUGIN_OPTION_APIKEY', 'CLAUDE_PLUGIN_OPTION_apiKey', 'PRISM_DEBUG']) delete env[key];

  const shown = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...env, CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'true' },
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stderr, '');
  assert.deepEqual(assertJsonOrEmpty(shown.stdout), {
    systemMessage: '[Prism] API key not configured. Run /prism:setup prism_YOUR_KEY.',
  });

  // Opt-in default: without the option set, display output stays suppressed.
  const defaulted = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ ...input, session_id: 'missing-config-default' }),
    env,
  });
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.equal(defaulted.stderr, '');
  assert.equal(assertJsonOrEmpty(defaulted.stdout), null);

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

test('submit emits no display output on a captured turn and retains capture', () => {
  const home = makeTempDir('prism-submit-nooutput-home-');
  const dataDir = makeTempDir('prism-submit-nooutput-data-');
  const sessionId = 'submit-no-output';
  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId, prompt_id: 'host-nooutput', prompt: 'normal prompt' }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_nooutput_test',
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'true',
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
    CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'true',
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
  assert.match(assertJsonOrEmpty(stop.stdout).systemMessage, /^\[Prism\] B live · refactor \(t1\) · /);
  assert.equal(readSessionRecord(dataDir, () => session.readTurn(fixture.stop.session_id)).active.status, 'consumed');
  assert.equal(readSessionRecord(dataDir, () => session.readSummary(fixture.stop.session_id)).contextHealth.turnCount, 1);
  assert.equal(readAllFiles(home).includes(SENTINEL), false);
  assert.equal(readAllFiles(dataDir).includes(SENTINEL), false);
});
