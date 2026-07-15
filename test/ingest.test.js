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
const ENV_KEYS = ['HOME', 'PRISM_INGEST_URL', 'PRISM_API_KEY', 'PRISM_GCK_KEY'];
const MODULE_PATHS = [
  '../lib/config',
  '../lib/debug',
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

async function loadIngestWithCapture(apiKey = API_KEY, envName = 'PRISM_API_KEY') {
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
      response.end('accepted');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  process.env.PRISM_INGEST_URL = `http://127.0.0.1:${address.port}`;
  delete process.env.PRISM_API_KEY;
  delete process.env.PRISM_GCK_KEY;
  process.env[envName] = apiKey;
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
  delete process.env.PRISM_INGEST_URL;
  delete process.env.PRISM_API_KEY;
  delete process.env.PRISM_GCK_KEY;
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
  const { ingest, requestReceived } = await loadIngestWithCapture();
  const input = {
    prompt_text: '안녕 Prism',
    source: 'claude-code-test',
    tool_session_id: 'session-prompt',
    cwd: '/tmp/project',
    metadata: { editor: 'test', sequence: 1 },
  };
  const expectedBody = {
    prompt_text: input.prompt_text,
    source: input.source,
    tool_session_id: input.tool_session_id,
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

test('sendResponse preserves the Hook response request and adds plugin provenance', async () => {
  const { ingest, requestReceived } = await loadIngestWithCapture();
  const input = {
    tool_session_id: 'session-response',
    response_text: 'completed',
    elapsed_ms: 125,
    input_tokens: 10,
    output_tokens: 20,
    model: 'claude-test',
    cost_usd: 0.001,
  };
  const expectedBody = {
    tool_session_id: input.tool_session_id,
    response_text: input.response_text,
    elapsed_ms: input.elapsed_ms,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    model: input.model,
    cost_usd: input.cost_usd,
  };

  const [result, request] = await Promise.all([
    ingest.sendResponse(input),
    requestReceived,
  ]);

  assert.deepEqual(result, { status: 202, body: 'accepted' });
  assertRequest(request, '/v1/prompts/response', expectedBody);
});

test('sendPrompt preserves a legacy API key in the request header', async () => {
  const { ingest, requestReceived } = await loadIngestWithCapture(
    LEGACY_API_KEY,
    'PRISM_GCK_KEY',
  );
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
