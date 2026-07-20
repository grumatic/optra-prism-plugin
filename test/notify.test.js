const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');

const ENV_KEYS = ['HOME', 'PRISM_INGEST_URL'];
const MODULE_PATHS = ['../lib/config', '../lib/notify'];

let homeDir;
let originalEnv;
let originalFetch;

function clearModules() {
  for (const modulePath of MODULE_PATHS) delete require.cache[require.resolve(modulePath)];
}

function writeConfig(value) {
  const file = path.join(homeDir, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-notify-test-'));
  originalEnv = new Map(ENV_KEYS.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
  originalFetch = global.fetch;
  process.env.HOME = homeDir;
  process.env.PRISM_INGEST_URL = 'https://ignored-env.example';
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

test('setup notification uses config.json and preserves an opaque non-empty key', async () => {
  const apiKey = 'opaque notify key';
  writeConfig({ ingest_url: 'https://config-ingest.example/base/' });
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 204 };
  };

  const { notifySetupComplete } = require('../lib/notify');
  assert.deepEqual(await notifySetupComplete(apiKey), {
    ok: true,
    httpStatus: 204,
    error: null,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://config-ingest.example/base/v1/setup-complete');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${apiKey}`);
  assert.deepEqual(Object.keys(JSON.parse(requests[0].options.body)), ['plugin_version']);
});

test('empty and non-string keys are rejected without a request', async () => {
  writeConfig({ ingest_url: 'https://config-ingest.example' });
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return { ok: true };
  };
  const { notifySetupComplete } = require('../lib/notify');

  for (const value of ['', null, undefined, 123]) {
    assert.deepEqual(await notifySetupComplete(value), {
      ok: false,
      httpStatus: null,
      error: 'API key is missing',
    });
  }
  assert.equal(requests, 0);
});

test('notification preserves network and backend failure details', async () => {
  writeConfig({ ingest_url: 'https://config-ingest.example' });
  const { notifySetupComplete } = require('../lib/notify');
  global.fetch = async () => { throw new Error('DNS lookup failed'); };
  assert.deepEqual(await notifySetupComplete('opaque'), {
    ok: false,
    httpStatus: null,
    error: 'DNS lookup failed',
  });

  global.fetch = async () => ({ ok: false, status: 403 });
  assert.deepEqual(await notifySetupComplete('opaque'), {
    ok: false,
    httpStatus: 403,
    error: 'HTTP 403',
  });
});
