const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');

const OPAQUE_KEY = 'opaque key with no required prefix';
const ENV_KEYS = [
  'HOME',
  'PRISM_API_KEY',
  'PRISM_GCK_KEY',
  'PRISM_INGEST_URL',
  'PRISM_THRESHOLD',
  'CLAUDE_PLUGIN_OPTION_APIKEY',
  'CLAUDE_PLUGIN_OPTION_apiKey',
  'CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD',
  'CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY',
];
const MODULE_PATHS = ['../lib/config', '../lib/env'];

let homeDir;
let originalEnv;
let originalFetch;

function configFile() {
  return path.join(homeDir, '.prism', 'config.json');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) delete require.cache[require.resolve(modulePath)];
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-config-test-'));
  originalEnv = new Map(ENV_KEYS.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
  originalFetch = global.fetch;
  process.env.HOME = homeDir;
  clearModules();
});

afterEach(() => {
  for (const [key, original] of originalEnv) {
    if (original.present) process.env[key] = original.value;
    else delete process.env[key];
  }
  global.fetch = originalFetch;
  clearModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('config.json is the sole runtime authority and env/userConfig values are ignored', () => {
  writeJson(configFile(), {
    apiKey: OPAQUE_KEY,
    ingest_url: 'https://config-ingest.example/base',
    showRealtimeSummary: true,
    legacyField: 'preserved',
  });
  Object.assign(process.env, {
    PRISM_API_KEY: 'env-key',
    PRISM_GCK_KEY: 'legacy-env-key',
    PRISM_INGEST_URL: 'https://env-ingest.example',
    PRISM_THRESHOLD: '9',
    CLAUDE_PLUGIN_OPTION_APIKEY: 'user-config-key',
    CLAUDE_PLUGIN_OPTION_apiKey: 'compat-user-config-key',
    CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD: '2',
    CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'false',
  });

  const config = require('../lib/config').getConfig();
  const runtime = require('../lib/env');

  assert.equal(config.apiKey, OPAQUE_KEY);
  assert.equal(config.ingest_url, 'https://config-ingest.example/base');
  assert.equal(config.showRealtimeSummary, true);
  assert.equal(config.legacyField, 'preserved');
  assert.equal(runtime.API_KEY, OPAQUE_KEY);
  assert.equal(runtime.INGEST_URL, 'https://config-ingest.example/base');
  assert.equal(runtime.SHOW_REALTIME_SUMMARY, true);
  assert.equal(Object.hasOwn(runtime, 'PRISM_THRESHOLD'), false);
});

test('missing config has no implicit runtime route even when legacy inputs are present', () => {
  Object.assign(process.env, {
    PRISM_API_KEY: 'env-key',
    PRISM_INGEST_URL: 'https://env-ingest.example',
    CLAUDE_PLUGIN_OPTION_APIKEY: 'user-config-key',
  });

  const { getConfig } = require('../lib/config');
  assert.deepEqual(getConfig(), {
    apiKey: '',
    showRealtimeSummary: false,
  });
});

test('runtime config preserves stored values without URL or boolean reinterpretation', () => {
  writeJson(configFile(), {
    apiKey: OPAQUE_KEY,
    ingest_url: 'https://config-ingest.example/base/',
    showRealtimeSummary: 'false',
  });

  const configModule = require('../lib/config');
  assert.equal(configModule.getConfig().ingest_url, 'https://config-ingest.example/base/');
  assert.equal(configModule.getConfig().showRealtimeSummary, 'false');
  const runtime = require('../lib/env');
  assert.equal(runtime.INGEST_URL, 'https://config-ingest.example/base/');
  assert.equal(runtime.SHOW_REALTIME_SUMMARY, false);

  writeJson(configFile(), { showRealtimeSummary: 'true', ingest_url: 'http://remote.example' });
  assert.equal(configModule.getConfig().showRealtimeSummary, 'true');
  assert.equal(configModule.getConfig().ingest_url, 'http://remote.example');

  writeJson(configFile(), { showRealtimeSummary: 'invalid' });
  assert.equal(configModule.getConfig().showRealtimeSummary, 'invalid');

  for (const ingestUrl of ['https://host.example?', 'https://host.example#']) {
    writeJson(configFile(), { ingest_url: ingestUrl });
    assert.equal(configModule.getConfig().ingest_url, ingestUrl);
  }
});

test('an unsafe stored URL remains visible but is not used as a runtime route', () => {
  writeJson(configFile(), {
    apiKey: OPAQUE_KEY,
    ingest_url: 'http://remote.example',
  });

  const config = require('../lib/config').getConfig();
  const runtime = require('../lib/env');

  assert.equal(config.ingest_url, 'http://remote.example');
  assert.equal(runtime.API_KEY, OPAQUE_KEY);
  assert.equal(runtime.INGEST_URL, '');
});

test('read, patch, and write preserve config fields and secure the authority file', () => {
  const config = require('../lib/config');
  config.writeConfig({ custom: { preserved: true }, prismThreshold: 2 });
  config.patchConfig({ showRealtimeSummary: true });

  assert.deepEqual(config.readConfig(), {
    custom: { preserved: true },
    prismThreshold: 2,
    showRealtimeSummary: true,
  });
  assert.equal(fs.statSync(path.dirname(configFile())).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configFile()).mode & 0o777, 0o600);
});

test('fetch sends an opaque key to the configured bootstrap and keeps only used remote fields', async () => {
  writeJson(configFile(), {
    ingest_url: 'http://127.0.0.1:9005/bootstrap/',
    localOnly: 'preserved',
  });
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ingest_url: 'https://remote-ingest.example/',
        dashboard_url: 'https://remote-dashboard.example',
        environment: 'test',
        apiKey: 'must-not-be-accepted-from-server',
        futureField: 'ignored',
      }),
    };
  };

  const { fetchConfig } = require('../lib/config');
  assert.deepEqual(await fetchConfig(OPAQUE_KEY), {
    status: 'server',
    config: {
      ingest_url: 'https://remote-ingest.example/',
      dashboard_url: 'https://remote-dashboard.example',
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:9005/bootstrap/v1/plugin/config');
  assert.equal(requests[0].options.headers['x-api-key'], OPAQUE_KEY);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile(), 'utf8')), {
    ingest_url: 'http://127.0.0.1:9005/bootstrap/',
    localOnly: 'preserved',
  });
});

test('backend 401 and 403 responses are authoritative authentication failures', async () => {
  const { fetchConfig } = require('../lib/config');

  for (const status of [401, 403]) {
    global.fetch = async () => ({ ok: false, status });
    assert.deepEqual(await fetchConfig('anything non-empty'), {
      status: 'auth-error',
      authStatus: status,
    });
  }
});

test('invalid keys and fetch errors retain the original config and failure reason', async () => {
  writeJson(configFile(), { ingest_url: 'http://127.0.0.1:9005', marker: true });
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('connection refused');
  };

  const { fetchConfig } = require('../lib/config');
  assert.equal(require('../lib/config').getConfig().ingest_url, 'http://127.0.0.1:9005');
  assert.deepEqual(await fetchConfig(''), { status: 'missing-key' });
  assert.deepEqual(await fetchConfig('opaque'), {
    status: 'error',
    message: 'Unable to fetch Prism configuration: connection refused',
  });
  assert.equal(fetchCalls, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile(), 'utf8')), {
    ingest_url: 'http://127.0.0.1:9005',
    marker: true,
  });
});

test('fetch refuses an unsafe configured bootstrap before sending the API key', async () => {
  writeJson(configFile(), { ingest_url: 'http://remote.example', marker: true });
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('must not run');
  };

  const { fetchConfig } = require('../lib/config');
  const result = await fetchConfig(OPAQUE_KEY);

  assert.equal(result.status, 'error');
  assert.match(result.message, /HTTP on loopback/);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile(), 'utf8')), {
    ingest_url: 'http://remote.example',
    marker: true,
  });
});

test('fetch reports HTTP, JSON, and unsupported ingest_url failures distinctly', async () => {
  const { fetchConfig } = require('../lib/config');

  global.fetch = async () => ({ ok: false, status: 503 });
  assert.deepEqual(await fetchConfig(OPAQUE_KEY), {
    status: 'error',
    message: 'Config endpoint returned HTTP 503.',
    httpStatus: 503,
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('unexpected token'); },
  });
  assert.deepEqual(await fetchConfig(OPAQUE_KEY), {
    status: 'error',
    message: 'Config endpoint returned invalid JSON: unexpected token',
    httpStatus: 200,
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ dashboard_url: 'https://dashboard.example' }),
  });
  assert.deepEqual(await fetchConfig(OPAQUE_KEY), {
    status: 'error',
    message:
      'Config endpoint response is missing a supported ingest_url ' +
      '(HTTPS, or HTTP on loopback, without credentials, query, or fragment).',
    httpStatus: 200,
  });

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ingest_url: 'ftp://ingest.example' }),
  });
  assert.deepEqual(await fetchConfig(OPAQUE_KEY), {
    status: 'error',
    message:
      'Config endpoint response is missing a supported ingest_url ' +
      '(HTTPS, or HTTP on loopback, without credentials, query, or fragment).',
    httpStatus: 200,
  });
});
