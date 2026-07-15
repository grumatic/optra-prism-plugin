const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');

const API_KEY = 'gck_1234567890abcdef';
const PROD_INGEST_URL = 'https://ingest.optra-prism.com';

let homeDir;
let originalEnv;
let originalFetch;

const ENV_KEYS = [
  'HOME',
  'PRISM_INGEST_URL',
  'PRISM_GCK_KEY',
  'CLAUDE_PLUGIN_OPTION_apiKey',
];

function prismPath(file) {
  return path.join(homeDir, '.prism', file);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeCache(overrides = {}) {
  writeJson(prismPath('config-cache.json'), {
    ingest_url: 'https://cached-ingest.example',
    dashboard_url: 'https://cached-dashboard.example',
    environment: 'test',
    key_prefix: API_KEY.substring(0, 12),
    cached_at: new Date().toISOString(),
    ...overrides,
  });
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-config-test-'));
  originalEnv = new Map(ENV_KEYS.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
  originalFetch = global.fetch;
  process.env.HOME = homeDir;
  delete process.env.PRISM_INGEST_URL;
  delete process.env.PRISM_GCK_KEY;
  delete process.env.CLAUDE_PLUGIN_OPTION_apiKey;
});

afterEach(() => {
  for (const [key, original] of originalEnv) {
    if (original.present) process.env[key] = original.value;
    else delete process.env[key];
  }
  global.fetch = originalFetch;
  clearModule('../lib/config');
  clearModule('../lib/env');
  clearModule('../lib/settings');
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('resolves ingest URL by env, local config, cache, then production', () => {
  const { getConfig } = require('../lib/config');

  writeCache();
  assert.equal(getConfig(API_KEY).ingest_url, 'https://cached-ingest.example');

  writeJson(prismPath('config.json'), {
    apiKey: API_KEY,
    ingest_url: 'https://local-ingest.example/',
  });
  assert.equal(getConfig(API_KEY).ingest_url, 'https://local-ingest.example');

  process.env.PRISM_INGEST_URL = 'https://env-ingest.example/';
  assert.equal(getConfig(API_KEY).ingest_url, 'https://env-ingest.example');

  delete process.env.PRISM_INGEST_URL;
  fs.rmSync(prismPath('config.json'));
  fs.rmSync(prismPath('config-cache.json'));
  assert.equal(getConfig(API_KEY).ingest_url, PROD_INGEST_URL);
});

test('local ingest override does not replace the cached dashboard URL', () => {
  const { getConfig } = require('../lib/config');

  writeCache();
  writeJson(prismPath('config.json'), {
    apiKey: API_KEY,
    ingest_url: 'https://local-ingest.example',
  });

  const resolved = getConfig(API_KEY);
  assert.equal(resolved.ingest_url, 'https://local-ingest.example');
  assert.equal(resolved.dashboard_url, 'https://cached-dashboard.example');
  assert.deepEqual(Object.keys(resolved).sort(), ['dashboard_url', 'environment', 'ingest_url']);
});

test('runtime and native OTEL settings use the same local ingest override', () => {
  writeCache();
  writeJson(prismPath('config.json'), {
    apiKey: API_KEY,
    ingest_url: 'https://local-ingest.example/prism/',
  });
  process.env.CLAUDE_PLUGIN_OPTION_apiKey = API_KEY;

  clearModule('../lib/env');
  clearModule('../lib/settings');
  const runtime = require('../lib/env');
  const { buildExpectedOtelEnv } = require('../lib/settings');
  const expected = buildExpectedOtelEnv();

  assert.equal(runtime.INGEST_URL, 'https://local-ingest.example/prism');
  assert.equal(expected.otelEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    'https://local-ingest.example/prism/v1/logs');
  assert.equal(expected.otelEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    'https://local-ingest.example/prism/v1/metrics');
});

test('invalid explicit override fails closed instead of using local, cache, or production', async () => {
  const config = require('../lib/config');
  writeCache();
  writeJson(prismPath('config.json'), {
    apiKey: API_KEY,
    ingest_url: 'https://valid-local.example',
  });
  process.env.PRISM_INGEST_URL = 'http://remote-ingest.example';

  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected fetch');
  };

  assert.equal(config.getConfig(API_KEY).ingest_url, null);
  assert.equal(config.getConfigEndpoint(), null);
  assert.equal(await config.fetchConfig(API_KEY), null);
  assert.equal(fetchCalls, 0);
});

test('rejects unsafe local override URL forms', () => {
  const { getConfig } = require('../lib/config');
  writeCache();

  const unsafeUrls = [
    'http://remote-ingest.example',
    'https://user:secret@ingest.example',
    'https://ingest.example?environment=test',
    'https://ingest.example#fragment',
    'file:///tmp/ingest',
    '',
  ];

  for (const ingestUrl of unsafeUrls) {
    writeJson(prismPath('config.json'), { apiKey: API_KEY, ingest_url: ingestUrl });
    assert.equal(getConfig(API_KEY).ingest_url, null, ingestUrl || '(empty)');
  }
});

test('allows loopback HTTP overrides', () => {
  const { getConfig } = require('../lib/config');

  for (const ingestUrl of [
    'http://localhost:9005/prism/',
    'http://127.0.0.1:9005/prism/',
    'http://[::1]:9005/prism/',
  ]) {
    writeJson(prismPath('config.json'), { apiKey: API_KEY, ingest_url: ingestUrl });
    assert.equal(getConfig(API_KEY).ingest_url, ingestUrl.replace(/\/$/, ''));
  }
});

test('config refresh uses the override and allowlists fields persisted from the server', async () => {
  const config = require('../lib/config');
  const { readPluginVersion } = require('../lib/plugin-version');
  writeJson(prismPath('config.json'), {
    apiKey: API_KEY,
    ingest_url: 'https://local-ingest.example/prism/',
  });

  let requestedUrl;
  let requestedOptions;
  global.fetch = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return {
      ok: true,
      json: async () => ({
        ingest_url: 'https://server-ingest.example',
        gateway_url: 'https://server-gateway.example',
        anthropic_base_url: 'https://server-anthropic.example',
        enableGateway: true,
        dashboard_url: 'https://server-dashboard.example',
        environment: 'test',
        future_field: 'ignored',
      }),
    };
  };

  const resolved = await config.ensureCache(API_KEY);
  const cached = JSON.parse(fs.readFileSync(prismPath('config-cache.json'), 'utf8'));

  assert.equal(requestedUrl, 'https://local-ingest.example/prism/v1/plugin/config');
  assert.equal(requestedOptions.headers['x-api-key'], API_KEY);
  assert.equal(requestedOptions.headers['x-prism-plugin-version'], readPluginVersion());
  assert.equal(Object.hasOwn(requestedOptions.headers, 'x-prism-config-contract'), false);
  assert.equal(resolved.ingest_url, 'https://local-ingest.example/prism');
  assert.equal(cached.ingest_url, 'https://server-ingest.example');
  assert.deepEqual(Object.keys(cached).sort(), [
    'cached_at',
    'dashboard_url',
    'environment',
    'ingest_url',
    'key_prefix',
  ]);
  assert.equal(config.getConfig(API_KEY).ingest_url, 'https://local-ingest.example/prism');
});

test('legacy routing fields in an existing cache are ignored', () => {
  const { getCachedConfig, getConfig } = require('../lib/config');
  writeCache({
    gateway_url: 'https://stale-gateway.example',
    anthropic_base_url: 'https://stale-anthropic.example',
    enableGateway: true,
  });

  const cached = getCachedConfig(API_KEY);
  assert.deepEqual(Object.keys(cached).sort(), [
    'cached_at',
    'dashboard_url',
    'environment',
    'ingest_url',
    'key_prefix',
  ]);
  assert.deepEqual(Object.keys(getConfig(API_KEY)).sort(), [
    'dashboard_url',
    'environment',
    'ingest_url',
  ]);
});

test('fallback cache contains only telemetry service fields and metadata', async () => {
  const { ensureCache } = require('../lib/config');
  global.fetch = async () => { throw new Error('offline'); };

  const resolved = await ensureCache(API_KEY);
  const cached = JSON.parse(fs.readFileSync(prismPath('config-cache.json'), 'utf8'));

  assert.equal(resolved.source, 'fallback');
  assert.deepEqual(Object.keys(cached).sort(), [
    'cached_at',
    'dashboard_url',
    'environment',
    'ingest_url',
    'key_prefix',
    'source',
  ]);
});

test('config refresh retains the production bootstrap without an override', () => {
  const { CONFIG_ENDPOINT, getConfigEndpoint } = require('../lib/config');
  assert.equal(getConfigEndpoint(), CONFIG_ENDPOINT);
});
