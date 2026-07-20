const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');

const { readPluginVersion } = require('../lib/plugin-version');

const API_KEY = 'prism_ingest_test_key';
const LEGACY_API_KEY = 'gck_ingest_test_key';
const ENV_KEYS = [
  'HOME',
  'PRISM_INGEST_URL',
  'PRISM_API_KEY',
  'PRISM_GCK_KEY',
  'PRISM_THRESHOLD',
  'CLAUDE_PLUGIN_OPTION_APIKEY',
  'CLAUDE_PLUGIN_OPTION_apiKey',
  'CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD',
  'CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY',
];
const MODULE_PATHS = [
  '../lib/config',
  '../lib/debug',
  '../lib/engine',
  '../lib/env',
  '../lib/ingest',
  '../lib/plugin-version',
];

let homeDir;
let originalEnv;
let originalModules;
let server;

function resolvedModule(modulePath) {
  return require.resolve(modulePath);
}

function clearTestModules() {
  for (const modulePath of MODULE_PATHS) delete require.cache[resolvedModule(modulePath)];
}

function closeServer() {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeRuntimeConfig(value) {
  const configFile = path.join(homeDir, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadIngestWithCapture(apiKey = API_KEY, responseBody = 'accepted', trailingSlash = false) {
  let resolveRequest;
  const requestReceived = new Promise((resolve) => { resolveRequest = resolve; });

  server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      resolveRequest({
        body,
        headers: request.headers,
        method: request.method,
        path: request.url,
      });
      response.writeHead(202, { 'Content-Type': 'text/plain' });
      response.end(responseBody);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  writeRuntimeConfig({
    apiKey,
    ingest_url: `http://127.0.0.1:${address.port}${trailingSlash ? '/' : ''}`,
  });
  Object.assign(process.env, {
    PRISM_INGEST_URL: 'https://hostile-ingest.invalid',
    PRISM_API_KEY: 'hostile-prism-key',
    PRISM_GCK_KEY: 'hostile-gck-key',
    PRISM_THRESHOLD: '99',
    CLAUDE_PLUGIN_OPTION_APIKEY: 'hostile-official-key',
    CLAUDE_PLUGIN_OPTION_apiKey: 'hostile-compat-key',
    CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD: '88',
    CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'true',
  });
  clearTestModules();

  return {
    ingest: require('../lib/ingest'),
    requestReceived,
  };
}

function assertRequest(request, expectedPath, expectedBody, expectedApiKey = API_KEY) {
  const serializedBody = JSON.stringify(expectedBody);

  assert.equal(request.path, expectedPath);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['x-api-key'], expectedApiKey);
  assert.equal(request.headers['content-length'], String(Buffer.byteLength(serializedBody)));
  assert.equal(request.headers['x-prism-plugin-version'], readPluginVersion());
  assert.deepEqual(JSON.parse(request.body), expectedBody);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(request.body), 'plugin_version'), false);
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-ingest-test-'));
  originalEnv = new Map(ENV_KEYS.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
  originalModules = new Map(MODULE_PATHS.map((modulePath) => {
    const resolved = resolvedModule(modulePath);
    return [resolved, require.cache[resolved]];
  }));

  process.env.HOME = homeDir;
  for (const key of ENV_KEYS) {
    if (key !== 'HOME') delete process.env[key];
  }
  server = null;
});

afterEach(async () => {
  await closeServer();

  for (const [key, original] of originalEnv) {
    if (original.present) process.env[key] = original.value;
    else delete process.env[key];
  }

  clearTestModules();
  for (const [modulePath, cachedModule] of originalModules) {
    if (cachedModule) require.cache[modulePath] = cachedModule;
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('sendPrompt preserves the Hook prompt request and adds plugin provenance', async () => {
  const { ingest, requestReceived } = await loadIngestWithCapture(API_KEY, 'accepted', true);
  const input = {
    prompt_text: '안녕 Prism',
    source: 'claude-code-test',
    tool_session_id: 'session-prompt',
    client_event_id: 'client-event-prompt',
    cwd: '/tmp/project',
    metadata: { editor: 'test', sequence: 1 },
  };
  const expectedBody = {
    prompt_text: input.prompt_text,
    source: input.source,
    tool_session_id: input.tool_session_id,
    client_event_id: input.client_event_id,
    cwd: input.cwd,
    metadata: input.metadata,
  };

  const [result, request] = await Promise.all([
    ingest.sendPrompt(input),
    requestReceived,
  ]);

  assert.deepEqual(result, { status: 202, body: 'accepted' });
  assertRequest(request, '/v1/prompts', expectedBody);
});

test('engine report requests use one slash after a trailing-slash ingest URL', async () => {
  const { requestReceived } = await loadIngestWithCapture(API_KEY, '{}', true);
  const engine = require('../lib/engine');

  const [result, request] = await Promise.all([
    engine.quickReport(),
    requestReceived,
  ]);

  assert.deepEqual(result, { ok: true, reason: null, data: {} });
  assert.equal(request.path, '/v1/insights/report/quick');
  assert.equal(request.headers['x-api-key'], API_KEY);
});

test('healthCheck returns the HTTP evidence used by status and doctor', async () => {
  const { ingest, requestReceived } = await loadIngestWithCapture();
  const [health, request] = await Promise.all([
    ingest.healthCheck(),
    requestReceived,
  ]);

  assert.deepEqual(health, {
    ok: true,
    reachable: true,
    httpStatus: 202,
    error: null,
  });
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/health');
});

test('sendResponse preserves the Hook response request and adds plugin provenance', async () => {
  const { ingest, requestReceived } = await loadIngestWithCapture();
  const input = {
    tool_session_id: 'session-response',
    client_event_id: 'client-event-response',
    prompt_id: '44444444-4444-4444-8444-444444444444',
    response_text: 'completed',
    elapsed_ms: 125,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 5,
    cache_creation_tokens: 3,
    model: 'claude-test',
    cost_usd: 0.001,
    cost_catalog_revision: 42,
    cost_kind: 'public_list_price_estimate',
  };
  const expectedBody = {
    tool_session_id: input.tool_session_id,
    response_text: input.response_text,
    client_event_id: input.client_event_id,
    prompt_id: input.prompt_id,
    elapsed_ms: input.elapsed_ms,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    cache_read_tokens: input.cache_read_tokens,
    cache_creation_tokens: input.cache_creation_tokens,
    model: input.model,
    cost_usd: input.cost_usd,
    cost_catalog_revision: input.cost_catalog_revision,
    cost_kind: input.cost_kind,
  };

  const [result, request] = await Promise.all([
    ingest.sendResponse(input),
    requestReceived,
  ]);

  assert.deepEqual(result, { status: 202, body: 'accepted' });
  assertRequest(request, '/v1/prompts/response', expectedBody);
});
test('sendResponse omits incomplete cost provenance, including legacy cost-only payloads', async () => {
  const base = {
    tool_session_id: 'session-response',
    client_event_id: 'client-event-response',
    prompt_id: '44444444-4444-4444-8444-444444444444',
    response_text: 'completed',
    input_tokens: 10,
    output_tokens: 20,
    model: 'claude-test',
  };
  const partials = [
    ['legacy cost-only payload', { cost_usd: 0.001 }],
    ['revision only', { cost_catalog_revision: 42 }],
    ['kind only', { cost_kind: 'public_list_price_estimate' }],
    ['cost and revision', { cost_usd: 0.001, cost_catalog_revision: 42 }],
    ['cost and kind', { cost_usd: 0.001, cost_kind: 'public_list_price_estimate' }],
    ['revision and kind', { cost_catalog_revision: 42, cost_kind: 'public_list_price_estimate' }],
    ['invalid provenance values', { cost_usd: NaN, cost_catalog_revision: 0, cost_kind: 'estimated' }],
    ['negative cost', { cost_usd: -0.001, cost_catalog_revision: 42, cost_kind: 'public_list_price_estimate' }],
    ['infinite cost', { cost_usd: Infinity, cost_catalog_revision: 42, cost_kind: 'public_list_price_estimate' }],
  ];
  for (const [name, provenance] of partials) {
    await closeServer();
    const { ingest, requestReceived } = await loadIngestWithCapture();
    const [, request] = await Promise.all([
      ingest.sendResponse({ ...base, ...provenance }),
      requestReceived,
    ]);
    const body = JSON.parse(request.body);
    assert.equal(body.model, base.model, name);
    assert.equal(body.input_tokens, base.input_tokens, name);
    for (const key of ['cost_usd', 'cost_catalog_revision', 'cost_kind']) {
      assert.equal(Object.hasOwn(body, key), false, `${name}: ${key}`);
    }
  }
});
test('sendResponse rejects incomplete or invalid dual correlation before network I/O', async () => {
  const { ingest } = await loadIngestWithCapture();
  await assert.rejects(
    ingest.sendResponse({ tool_session_id: 'session-only', response_text: 'completed' }),
    /client_event_id and server prompt_id/,
  );
  await assert.rejects(
    ingest.sendResponse({
      tool_session_id: 'client-only',
      client_event_id: 'client-event',
      response_text: 'completed',
    }),
    /client_event_id and server prompt_id/,
  );
  await assert.rejects(
    ingest.sendResponse({
      tool_session_id: 'nil-server-id',
      client_event_id: 'client-event',
      prompt_id: '00000000-0000-0000-0000-000000000000',
      response_text: 'completed',
    }),
    /client_event_id and server prompt_id/,
  );
});

test('sendPrompt preserves a legacy API key from config in the request header', async () => {
  const { ingest, requestReceived } = await loadIngestWithCapture(LEGACY_API_KEY);
  const input = {
    prompt_text: 'legacy key',
    source: 'claude-code-test',
    tool_session_id: 'session-legacy',
    cwd: '/tmp/project',
    metadata: {},
  };

  const [result, request] = await Promise.all([
    ingest.sendPrompt(input),
    requestReceived,
  ]);

  assert.deepEqual(result, { status: 202, body: 'accepted' });
  assertRequest(request, '/v1/prompts', input, LEGACY_API_KEY);
});
test('debug logging records response metadata without echoing response contents', async () => {
  const sentinel = 'prism_response_secret_sentinel';
  const { ingest, requestReceived } = await loadIngestWithCapture(
    API_KEY,
    JSON.stringify({ id: 'opaque-response-id', echoed_prompt: sentinel }),
  );

  await Promise.all([
    ingest.sendPrompt({ prompt_text: 'private prompt', tool_session_id: 'debug-session' }),
    requestReceived,
  ]);

  const debugLog = fs.readFileSync(path.join(homeDir, '.prism', 'logs', 'debug.log'), 'utf8');
  assert.match(debugLog, /body_length=/);
  assert.match(debugLog, /id=opaque-response-id/);
  assert.doesNotMatch(debugLog, new RegExp(sentinel));
});
