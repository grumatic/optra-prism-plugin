const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SUBMIT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'submit-handler.js');
const SESSION_START = path.join(ROOT, 'hooks', 'scripts', 'session-start.sh');
const SESSION_START_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'session-start-handler.js');
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

function writeRuntimeConfig(home, value) {
  const configFile = path.join(home, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function seedInstalledPlugin(home, projectDir, scope = 'local') {
  writeJsonFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: {
      'prism@optra-prism': [{
        scope,
        projectPath: projectDir,
        installPath: ROOT,
      }],
    },
  });
}

function seedFreshPluginUpdateCache(dataDir, latestVersion) {
  const {
    cachePathFor,
    readCurrentPluginVersion,
    writeUpdateCache,
  } = require('../lib/plugin-update');
  if (fs.existsSync(cachePathFor(dataDir))) return;
  const now = new Date().toISOString();
  assert.equal(writeUpdateCache(dataDir, {
    checkedAt: now,
    lastSuccessAt: now,
    etag: null,
    latestVersion: latestVersion || readCurrentPluginVersion({ pluginRoot: ROOT }),
  }), true);
}

function runtimeEnv(home, dataDir, config, extra = {}) {
  writeRuntimeConfig(home, config);
  return {
    ...process.env,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    PRISM_API_KEY: 'hostile-prism-key',
    PRISM_GCK_KEY: 'hostile-gck-key',
    PRISM_INGEST_URL: 'https://hostile-ingest.invalid',
    PRISM_THRESHOLD: '99',
    PRISM_DEBUG: '1',
    CLAUDE_PLUGIN_OPTION_APIKEY: 'hostile-option-key',
    CLAUDE_PLUGIN_OPTION_apiKey: 'hostile-compat-key',
    CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD: '88',
    CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: config.show_realtime_summary === true ? 'false' : 'true',
    ...extra,
  };
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
function writeCrashAfterPrompt2xxInterceptor(home) {
  const interceptor = path.join(home, 'crash-after-prompt-2xx.js');
  fs.writeFileSync(interceptor, [
    "const events = require('node:events');",
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  const request = new events.EventEmitter();',
    '  request.write = () => {};',
    '  request.destroy = () => {};',
    '  request.end = () => {',
    "    fs.writeFileSync(process.env.PRISM_CRASH_MARKER, url.pathname);",
    '    const response = new events.EventEmitter();',
    '    response.statusCode = 201;',
    '    callback(response);',
    "    response.emit('data', Buffer.from('{\"id\":\"5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f\"}'));",
    "    response.emit('end');",
    '    process.exit(0);',
    '  };',
    '  return request;',
    '};',
    '',
  ].join('\n'));
  return interceptor;
}

function runSessionStart(home, dataDir, input, env = {}) {
  seedFreshPluginUpdateCache(dataDir);
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
async function startTricklingServer() {
  let resolveResponseClosed;
  const responseClosed = new Promise((resolve) => { resolveResponseClosed = resolve; });
  const server = require('node:http').createServer((request, response) => {
    request.resume();
    response.writeHead(202, { 'Content-Type': 'text/plain' });
    const trickle = setInterval(() => response.write('.'), 10);
    response.on('close', () => {
      clearInterval(trickle);
      resolveResponseClosed();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    responseClosed,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function runHook(command, args, input, env, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(JSON.stringify(input));
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
    env: runtimeEnv(home, dataDir, {
      apiKey: 'prism_1234567890abcdef',
      ingest_url: 'http://127.0.0.1:9',
    }, {
      PRISM_FETCH_MARKER: fetchMarker,
      NODE_OPTIONS: `--require=${fetchBlocker}`,
    }),
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
      env: runtimeEnv(home, dataDir, {
        apiKey: 'prism_control_test',
        ingest_url: 'http://127.0.0.1:12345',
      }, {
        PRISM_POST_MARKER: postMarker,
        NODE_OPTIONS: `--require=${writePostInterceptor(home)}`,
      }),
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

test('submit does not activate plugin metadata when its control barrier fails', () => {
  const home = makeTempDir('prism-control-barrier-home-');
  const dataDir = makeTempDir('prism-control-barrier-data-');
  const projectDir = path.join(home, 'project');
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(projectDir);
  seedInstalledPlugin(home, projectDir);
  writeJsonFile(settingsFile, {
    env: {
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=old,x-prism-plugin-version=0.0.1',
    },
  });
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '0.0.1');

  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: '', cwd: projectDir, prompt: '/prism:status' }),
    env: runtimeEnv(home, dataDir, {
      apiKey: 'prism_barrier_test',
      ingest_url: 'http://127.0.0.1:9',
      show_realtime_summary: false,
    }, {
      CLAUDE_PLUGIN_ROOT: ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  assert.equal(
    JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.OTEL_EXPORTER_OTLP_HEADERS,
    'x-api-key=old,x-prism-plugin-version=0.0.1',
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'last-version.txt'), 'utf8'), '0.0.1');
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
      env: runtimeEnv(home, dataDir, {
        apiKey: 'prism_nonstring_test',
        ingest_url: 'http://127.0.0.1:12345',
      }, {
        PRISM_POST_MARKER: postMarker,
        NODE_OPTIONS: `--require=${writePostInterceptor(home)}`,
      }),
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
test('SessionStart accepts an opaque config key without fetch, OTEL repair, or env-file writes', () => {
  const home = makeTempDir('prism-session-start-config-home-');
  const dataDir = makeTempDir('prism-session-start-config-data-');
  const envFile = path.join(home, 'session-env');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const fetchMarker = path.join(home, 'fetch-called');
  const fetchBlocker = path.join(home, 'block-fetch.js');
  const apiKey = 'opaque-session-key-without-prefix';
  const sessionId = 'config-session';
  seedActive(dataDir, sessionId);
  writeRuntimeConfig(home, {
    apiKey,
    ingest_url: 'https://config-ingest.example',
  });
  fs.writeFileSync(path.join(home, '.prism', 'config-cache.json'), JSON.stringify({
    ingest_url: 'https://stale-cache.example',
    source: 'auth-error',
    auth_status: 401,
  }));
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"keep"}}\n');
  fs.writeFileSync(envFile, 'export KEEP_ME=1\n');
  fs.writeFileSync(fetchBlocker, [
    "const fs = require('node:fs');",
    'global.fetch = async () => {',
    "  fs.writeFileSync(process.env.PRISM_FETCH_MARKER, 'called');",
    "  throw new Error('fetch blocked');",
    '};',
  ].join('\n'));

  const result = runSessionStart(home, dataDir, {
    session_id: sessionId,
    source: 'startup',
  }, {
    PRISM_API_KEY: 'hostile-env-key',
    PRISM_INGEST_URL: 'https://hostile-ingest.invalid',
    CLAUDE_PLUGIN_OPTION_APIKEY: 'hostile-option-key',
    CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD: '99',
    CLAUDE_ENV_FILE: envFile,
    PRISM_FETCH_MARKER: fetchMarker,
    NODE_OPTIONS: `--require=${fetchBlocker}`,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Session started/);
  assert.match(result.stderr, /Ingest:\s+https:\/\/config-ingest\.example/);
  assert.doesNotMatch(result.stderr, /rejected|invalid.*key/i);
  assert.equal(result.stderr.includes(apiKey), false);
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'export KEEP_ME=1\n');
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"keep"}}\n');
  assert.equal(fs.existsSync(fetchMarker), false);
  assertLifecycleInvalidated(dataDir, sessionId);
});

test('SessionStart ignores hostile API key env and advances the barrier before a missing-config exit', () => {
  const home = makeTempDir('prism-session-start-missing-home-');
  const dataDir = makeTempDir('prism-session-start-missing-data-');
  const sessionId = 'missing-key-session';
  seedActive(dataDir, sessionId);

  const result = runSessionStart(home, dataDir, { session_id: sessionId, source: 'startup' }, {
    PRISM_API_KEY: 'prism_hostile_env_key',
    PRISM_GCK_KEY: 'gck_hostile_env_key',
    CLAUDE_PLUGIN_OPTION_APIKEY: 'prism_hostile_option_key',
    CLAUDE_PLUGIN_OPTION_apiKey: 'prism_hostile_compat_key',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /No API key configured/);
  assert.doesNotMatch(result.stderr, /Session started/);
  assertLifecycleInvalidated(dataDir, sessionId);
});

test('SessionStart reports an unsupported config ingest URL without claiming startup success', () => {
  const home = makeTempDir('prism-session-start-invalid-url-home-');
  const dataDir = makeTempDir('prism-session-start-invalid-url-data-');
  const sessionId = 'invalid-url-session';
  seedActive(dataDir, sessionId);
  writeRuntimeConfig(home, {
    apiKey: 'opaque-key',
    ingest_url: 'http://remote.example',
  });

  const result = runSessionStart(home, dataDir, { session_id: sessionId, source: 'startup' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /ingest_url .* is missing or unsupported/);
  assert.doesNotMatch(result.stderr, /Session started/);
  assertLifecycleInvalidated(dataDir, sessionId);
});

test('SessionStart reports a malformed config instead of claiming the key is missing', () => {
  const home = makeTempDir('prism-session-start-malformed-home-');
  const dataDir = makeTempDir('prism-session-start-malformed-data-');
  const sessionId = 'malformed-config-session';
  seedActive(dataDir, sessionId);
  const configFile = path.join(home, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '{ malformed json\n');

  const result = runSessionStart(home, dataDir, { session_id: sessionId, source: 'startup' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Unable to read ~\/\.prism\/config\.json/);
  assert.doesNotMatch(result.stderr, /No API key configured|Session started/);
  assertLifecycleInvalidated(dataDir, sessionId);
});

test('SessionStart skips activation when the lifecycle barrier is unavailable', () => {
  const home = makeTempDir('prism-session-barrier-home-');
  const dataDir = makeTempDir('prism-session-barrier-data-');
  const activationMarker = path.join(home, 'activation-called');
  const preload = path.join(home, 'fail-session-barrier.js');
  fs.writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const Module = require('node:module');",
    'const load = Module._load;',
    'Module._load = function(request, parent, isMain) {',
    "  if (request === '../../lib/session' && parent && parent.filename.endsWith('session-start-handler.js')) {",
    '    const session = load.call(this, request, parent, isMain);',
    '    return { ...session, advanceBarrier: () => null };',
    '  }',
    "  if (request === '../../lib/plugin-activation' && parent && parent.filename.endsWith('session-start-handler.js')) {",
    "    fs.writeFileSync(process.env.PRISM_ACTIVATION_MARKER, 'called');",
    '    return { collectPluginNotices: async () => ({ notices: [] }) };',
    '  }',
    '  return load.call(this, request, parent, isMain);',
    '};',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [SESSION_START_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'session-barrier-unavailable',
      source: 'startup',
      cwd: ROOT,
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_PLUGIN_ROOT: ROOT,
      PRISM_ACTIVATION_MARKER: activationMarker,
      NODE_OPTIONS: `--require=${preload}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  assert.equal(fs.existsSync(activationMarker), false);
});

test('SessionStart projects activated metadata before one combined restart and update notice', () => {
  const home = makeTempDir('prism-session-version-home-');
  const dataDir = makeTempDir('prism-session-version-data-');
  const projectDir = path.join(home, 'project');
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  const apiKey = 'opaque session activation key';
  fs.mkdirSync(projectDir);
  seedInstalledPlugin(home, projectDir);
  writeRuntimeConfig(home, {
    apiKey,
    ingest_url: 'https://ingest.example',
    show_realtime_summary: false,
  });
  writeJsonFile(settingsFile, {
    unrelated: 'preserve',
    env: {
      OTEL_LOGS_EXPORTER: 'intentionally-stale',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=old,x-prism-plugin-version=0.0.1',
    },
  });
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '0.0.1');
  seedFreshPluginUpdateCache(dataDir, '999.0.0');

  const currentVersion = require('../lib/plugin-update').readCurrentPluginVersion({
    pluginRoot: ROOT,
  });
  const result = runSessionStart(home, dataDir, {
    session_id: 'version-activation-session',
    source: 'startup',
    cwd: projectDir,
  }, {
    CLAUDE_PROJECT_DIR: projectDir,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(assertJsonOrEmpty(result.stdout), {
    systemMessage:
      `Prism has been updated to v${currentVersion}. `
      + 'Restart Claude Code to apply the new telemetry metadata immediately.\n'
      + 'Prism v999.0.0 is available. '
      + 'Update the plugin, run `/reload-plugins`, then restart Claude Code.',
  });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.unrelated, 'preserve');
  assert.equal(settings.env.OTEL_LOGS_EXPORTER, 'intentionally-stale');
  assert.equal(
    settings.env.OTEL_EXPORTER_OTLP_HEADERS,
    `x-api-key=${encodeURIComponent(apiKey)},x-prism-plugin-version=${currentVersion}`,
  );
  assert.equal(
    settings.otelHeadersHelper,
    path.join(dataDir, 'bin', 'prism-otel-headers-helper.js'),
  );
  assert.equal(fs.readFileSync(path.join(dataDir, 'last-version.txt'), 'utf8'), currentVersion);
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
    env: runtimeEnv(home, dataDir, {
      apiKey: 'prism_normal_capture',
      ingest_url: 'http://127.0.0.1:12345',
    }, {
      PRISM_PROMPT_MARKER: marker,
      NODE_OPTIONS: `--require=${interceptor}`,
    }),
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
    env: runtimeEnv(home, dataDir, {
      apiKey: 'prism_stop_handler_test',
      ingest_url: 'http://127.0.0.1:12345',
    }),
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
    env: runtimeEnv(home, dataDir, {
      apiKey: 'prism_post_attach',
      ingest_url: 'http://127.0.0.1:9',
    }, {
      NODE_OPTIONS: `--require=${hook}`,
    }),
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
  seedFreshPluginUpdateCache(dataDir);
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
test('Submit drain aborts a trickling POST at its deadline', async () => {
  const home = makeTempDir('prism-submit-trickle-home-');
  const dataDir = makeTempDir('prism-submit-trickle-data-');
  const server = await startTricklingServer();
  try {
    const startedAt = Date.now();
    const result = await runHook(process.execPath, [SUBMIT_HANDLER], {
      session_id: 'submit-trickle-session',
      prompt_id: 'submit-trickle-prompt',
      prompt: 'capture with deadline',
    }, runtimeEnv(home, dataDir, {
      apiKey: 'prism_submit_trickle',
      ingest_url: server.url,
    }));
    const elapsedMs = Date.now() - startedAt;

    await Promise.race([
      server.responseClosed,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('Submit drain did not abort the response')), 500)),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.ok(elapsedMs >= 1700, `Submit drain ended too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs <= 2600, `Submit drain exceeded its budget at ${elapsedMs}ms`);
    assert.equal(readSessionRecord(dataDir, () => require('../lib/response-outbox').listPending()).length, 1);
  } finally {
    await server.close();
  }
});

test('SessionStart drain aborts a trickling POST at its deadline', async () => {
  const home = makeTempDir('prism-session-start-trickle-home-');
  const dataDir = makeTempDir('prism-session-start-trickle-data-');
  const apiKey = 'prism_session_start_trickle';
  const server = await startTricklingServer();
  writeRuntimeConfig(home, { apiKey, ingest_url: server.url });
  seedFreshPluginUpdateCache(dataDir);
  readSessionRecord(dataDir, () => require('../lib/response-outbox').enqueue({
    id: 'prompt-session-start-trickle',
    kind: 'prompt',
    payload: {
      prompt_text: 'recover with deadline',
      source: 'claude-code',
      tool_session_id: 'prior-session-start-trickle',
      client_event_id: 'prior-session-start-event',
    },
  }));
  try {
    const startedAt = Date.now();
    const result = await runHook('bash', [SESSION_START], {
      session_id: 'session-start-trickle-session',
      source: 'startup',
    }, {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_PLUGIN_ROOT: ROOT,
      PRISM_API_KEY: apiKey,
      PRISM_INGEST_URL: server.url,
    });
    const elapsedMs = Date.now() - startedAt;

    await Promise.race([
      server.responseClosed,
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('SessionStart drain did not abort the response')), 500)),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.ok(elapsedMs >= 1700, `SessionStart drain ended too early after ${elapsedMs}ms`);
    assert.ok(elapsedMs <= 2600, `SessionStart drain exceeded its budget at ${elapsedMs}ms`);
    assert.equal(readSessionRecord(dataDir, () => require('../lib/response-outbox').listPending()).length, 1);
  } finally {
    await server.close();
  }
});
test('SessionStart replays a prior-session prompt and promotes its durable server id', () => {
  const home = makeTempDir('prism-session-replay-home-');
  const dataDir = makeTempDir('prism-session-replay-data-');
  const priorSessionId = 'prior-session-replay';
  const hostPromptId = 'prior-host-prompt';
  const barrier = readSessionRecord(dataDir, () => session.advanceBarrier(priorSessionId, 'normal-pending'));
  readSessionRecord(dataDir, () => session.attachActive(priorSessionId, {
    epoch: barrier.epoch,
    clientEventId: 'prior-event',
    submitPromptId: hostPromptId,
    submittedAt: new Date().toISOString(),
    transcriptBoundary: { byteOffset: 0, lineOffset: 0 },
    frozenPayloadHash: crypto.createHash('sha256').update('prior-replay').digest('hex'),
    status: 'submitting',
  }));
  readSessionRecord(dataDir, () => require('../lib/response-outbox').enqueue({
    id: 'prompt-prior-event',
    kind: 'prompt',
    payload: {
      prompt_text: 'recover me',
      source: 'claude-code',
      tool_session_id: priorSessionId,
      client_event_id: 'prior-event',
    },
    promotion: {
      sessionId: priorSessionId,
      epoch: barrier.epoch,
      clientEventId: 'prior-event',
      hostPromptId,
    },
  }));

  writeRuntimeConfig(home, {
    apiKey: 'prism_session_replay',
    ingest_url: 'http://127.0.0.1:9',
  });
  const result = runSessionStart(home, dataDir, { session_id: 'new-session', source: 'startup' }, {
    PRISM_API_KEY: 'prism_session_replay',
    PRISM_INGEST_URL: 'http://127.0.0.1:9',
    NODE_OPTIONS: `--require=${writeSuccessfulIngestInterceptor(home)}`,
  });
  assert.equal(result.status, 0, result.stderr);
  const priorTurn = readSessionRecord(dataDir, () => session.readTurn(priorSessionId));
  assert.equal(priorTurn.active.status, 'captured');
  assert.equal(priorTurn.active.serverPromptId, '5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f');
  assert.deepEqual(readSessionRecord(dataDir, () => require('../lib/response-outbox').listPending()), []);
});
test('submit treats the nil-UUID dropped-prompt acknowledgment as terminal', () => {
  const home = makeTempDir('prism-submit-nil-id-home-');
  const dataDir = makeTempDir('prism-submit-nil-id-data-');
  const hook = path.join(home, 'nil-id-interceptor.js');
  fs.writeFileSync(hook, [
    "const events = require('node:events');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  const request = new events.EventEmitter(); request.write = () => {}; request.destroy = () => {};',
    '  request.end = () => { const response = new events.EventEmitter(); response.statusCode = 200; callback(response); response.emit("data", Buffer.from(\'{"id":"00000000-0000-0000-0000-000000000000"}\')); response.emit("end"); };',
    '  return request;',
    '};',
  ].join('\n'));
  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'nil-server-id', prompt_id: 'host-prompt', prompt: 'capture this' }),
    env: runtimeEnv(home, dataDir, {
      apiKey: 'prism_submit_nil_id',
      ingest_url: 'http://127.0.0.1:9',
    }, {
      NODE_OPTIONS: `--require=${hook}`,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(assertJsonOrEmpty(result.stdout), null);
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'nil-server-id'), 'utf8'));
  assert.equal(turn.kind, 'normal-pending');
  assert.equal(turn.active.status, 'submitting');
  assert.equal(turn.active.serverPromptId, undefined);
  assert.deepEqual(readSessionRecord(dataDir, () => require('../lib/response-outbox').listPending()), []);
});
test('Stop replays an exactly-correlated submitting prompt before consuming its response', () => {
  const home = makeTempDir('prism-stop-recovery-home-');
  const dataDir = makeTempDir('prism-stop-recovery-data-');
  const transcript = path.join(home, 'transcript.jsonl');
  const crashMarker = path.join(home, 'prompt-2xx');
  const sessionId = 'same-session-stop-recovery';
  const hostPromptId = 'same-session-host-prompt';
  const assistantMessage = 'recovered assistant response';
  writeRuntimeConfig(home, {
    apiKey: 'prism_stop_recovery',
    ingest_url: 'http://127.0.0.1:9',
  });

  const submit = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: sessionId,
      prompt_id: hostPromptId,
      prompt: 'persist this prompt before the failpoint',
      transcript_path: transcript,
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_stop_recovery',
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      PRISM_CRASH_MARKER: crashMarker,
      NODE_OPTIONS: `--require=${writeCrashAfterPrompt2xxInterceptor(home)}`,
    },
    timeout: 3000,
  });
  assert.equal(submit.status, 0, submit.stderr);
  assert.equal(fs.readFileSync(crashMarker, 'utf8'), '/v1/prompts');
  assert.equal(readSessionRecord(dataDir, () => session.readTurn(sessionId)).active.status, 'submitting');
  assert.equal(readSessionRecord(dataDir, () => require('../lib/response-outbox').listPending()).length, 1);

  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', prompt_id: hostPromptId, message: { role: 'user', content: 'request' } }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'recovered-assistant',
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: assistantMessage,
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
      },
    }),
    '',
  ].join('\n'));

  const stop = spawnSync(process.execPath, [STOP_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: sessionId,
      prompt_id: hostPromptId,
      transcript_path: transcript,
      last_assistant_message: assistantMessage,
    }),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_API_KEY: 'prism_stop_recovery',
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      NODE_OPTIONS: `--require=${writeSuccessfulIngestInterceptor(home)}`,
    },
    timeout: 3000,
  });
  assert.equal(stop.status, 0, stop.stderr);
  const recovered = readSessionRecord(dataDir, () => session.readTurn(sessionId));
  assert.equal(recovered.active.status, 'consumed');
  assert.equal(recovered.active.serverPromptId, '5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f');
  assert.deepEqual(readSessionRecord(dataDir, () => require('../lib/response-outbox').listPending()), []);
});
test('submit uses JSON system messages for missing configuration and suppresses them when disabled', () => {
  const home = makeTempDir('prism-submit-config-home-');
  const dataDir = makeTempDir('prism-submit-config-data-');
  const input = { session_id: 'missing-config', prompt: 'normal prompt' };

  const shown = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: runtimeEnv(home, dataDir, { show_realtime_summary: true }),
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stderr, '');
  assert.deepEqual(assertJsonOrEmpty(shown.stdout), {
    systemMessage: '[Prism] API key not configured. Run /prism:setup YOUR_KEY.',
  });

  const missingUrl = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ ...input, session_id: 'missing-ingest-url' }),
    env: runtimeEnv(home, dataDir, {
      apiKey: 'opaque-key',
      ingest_url: null,
      show_realtime_summary: true,
    }),
  });
  assert.equal(missingUrl.status, 0, missingUrl.stderr);
  assert.equal(missingUrl.stderr, '');
  assert.deepEqual(assertJsonOrEmpty(missingUrl.stdout), {
    systemMessage:
      '[Prism] ingest_url not configured. Run /prism:setup YOUR_KEY or /prism:config.',
  });

  // Opt-in default: without the option set, display output stays suppressed.
  const defaulted = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ ...input, session_id: 'missing-config-default' }),
    env: runtimeEnv(home, dataDir, {}),
  });
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.equal(defaulted.stderr, '');
  assert.equal(assertJsonOrEmpty(defaulted.stdout), null);

  const hidden = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ ...input, session_id: 'missing-config-off' }),
    env: runtimeEnv(home, dataDir, { show_realtime_summary: false }),
  });
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(hidden.stderr, '');
  assert.equal(assertJsonOrEmpty(hidden.stdout), null);
});

test('first normal prompt after plugin reload always recommends restart and refreshes metadata', () => {
  const home = makeTempDir('prism-submit-version-home-');
  const dataDir = makeTempDir('prism-submit-version-data-');
  const projectDir = path.join(home, 'project');
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  const apiKey = 'opaque submit activation key';
  fs.mkdirSync(projectDir);
  seedInstalledPlugin(home, projectDir);
  writeJsonFile(settingsFile, {
    unrelated: 'preserve',
    env: {
      OTEL_LOGS_EXPORTER: 'intentionally-stale',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=old,x-prism-plugin-version=0.0.1',
    },
  });
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '0.0.1');
  const interceptor = writeSuccessfulIngestInterceptor(home);
  const currentVersion = require('../lib/plugin-update').readCurrentPluginVersion({
    pluginRoot: ROOT,
  });
  const env = runtimeEnv(home, dataDir, {
    apiKey,
    ingest_url: 'http://127.0.0.1:9',
    show_realtime_summary: false,
  }, {
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PROJECT_DIR: projectDir,
    NODE_OPTIONS: `--require=${interceptor}`,
  });

  const first = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'submit-version-first',
      prompt_id: 'submit-version-first-prompt',
      prompt: 'first prompt after reload',
      cwd: projectDir,
    }),
    env,
  });

  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(assertJsonOrEmpty(first.stdout), {
    systemMessage:
      `Prism has been updated to v${currentVersion}. `
      + 'Restart Claude Code to apply the new telemetry metadata immediately.',
  });
  const projected = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(projected.env.OTEL_LOGS_EXPORTER, 'intentionally-stale');
  assert.equal(
    projected.env.OTEL_EXPORTER_OTLP_HEADERS,
    `x-api-key=${encodeURIComponent(apiKey)},x-prism-plugin-version=${currentVersion}`,
  );
  assert.equal(projected.unrelated, 'preserve');
  assert.equal(fs.statSync(projected.otelHeadersHelper).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(dataDir, 'last-version.txt'), 'utf8'), currentVersion);

  const second = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'submit-version-second',
      prompt_id: 'submit-version-second-prompt',
      prompt: 'second prompt after reload',
      cwd: projectDir,
    }),
    env,
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(assertJsonOrEmpty(second.stdout), null);
});

test('first Prism control after plugin reload recommends restart without posting the control', () => {
  const home = makeTempDir('prism-submit-control-version-home-');
  const dataDir = makeTempDir('prism-submit-control-version-data-');
  const projectDir = path.join(home, 'project');
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  const postMarker = path.join(home, 'posts');
  const apiKey = 'opaque control activation key';
  fs.mkdirSync(projectDir);
  seedInstalledPlugin(home, projectDir);
  writeJsonFile(settingsFile, {
    unrelated: 'preserve',
    env: {
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=old,x-prism-plugin-version=0.0.1',
    },
  });
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '0.0.1');
  const currentVersion = require('../lib/plugin-update').readCurrentPluginVersion({
    pluginRoot: ROOT,
  });
  const env = runtimeEnv(home, dataDir, {
    apiKey,
    ingest_url: 'http://127.0.0.1:9',
    show_realtime_summary: false,
  }, {
    CLAUDE_PLUGIN_ROOT: ROOT,
    CLAUDE_PROJECT_DIR: projectDir,
    PRISM_POST_MARKER: postMarker,
    NODE_OPTIONS: `--require=${writePostInterceptor(home)}`,
  });

  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'submit-control-version',
      prompt_id: 'submit-control-version-prompt',
      prompt: '/prism:status',
      cwd: projectDir,
    }),
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(assertJsonOrEmpty(result.stdout), {
    systemMessage:
      `Prism has been updated to v${currentVersion}. `
      + 'Restart Claude Code to apply the new telemetry metadata immediately.',
  });
  assert.equal(fs.existsSync(postMarker), false);
  const turn = JSON.parse(fs.readFileSync(turnFile(dataDir, 'submit-control-version'), 'utf8'));
  assert.equal(turn.kind, 'control');
  assert.equal(turn.active, null);
  const projected = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(
    projected.env.OTEL_EXPORTER_OTLP_HEADERS,
    `x-api-key=${encodeURIComponent(apiKey)},x-prism-plugin-version=${currentVersion}`,
  );
  assert.equal(projected.unrelated, 'preserve');
  assert.equal(fs.readFileSync(path.join(dataDir, 'last-version.txt'), 'utf8'), currentVersion);
});

test('submit emits no display output on a captured turn and retains capture', () => {
  const home = makeTempDir('prism-submit-nooutput-home-');
  const dataDir = makeTempDir('prism-submit-nooutput-data-');
  const sessionId = 'submit-no-output';
  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({ session_id: sessionId, prompt_id: 'host-nooutput', prompt: 'normal prompt' }),
    env: runtimeEnv(home, dataDir, {
      apiKey: 'prism_nooutput_test',
      ingest_url: 'http://127.0.0.1:9',
      show_realtime_summary: true,
    }, {
      NODE_OPTIONS: `--require=${writeSuccessfulIngestInterceptor(home)}`,
    }),
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
  const env = runtimeEnv(home, dataDir, {
    apiKey: 'prism_host_fixture',
    ingest_url: 'http://127.0.0.1:9',
    show_realtime_summary: true,
  }, {
    NODE_OPTIONS: `--require=${interceptor}`,
  });

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
