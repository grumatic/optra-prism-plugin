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

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-notify-test-'));
  originalEnv = new Map(ENV_KEYS.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
  originalFetch = global.fetch;
  process.env.HOME = homeDir;
  process.env.PRISM_INGEST_URL = 'https://local-ingest.example';
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

for (const apiKey of ['prism_1234567890abcdef', 'gck_1234567890abcdef']) {
  test(`setup notification accepts ${apiKey.split('_', 1)[0]} API keys`, async () => {
    const requests = [];
    global.fetch = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/v1/plugin/config')) {
        return {
          ok: true,
          json: async () => ({
            ingest_url: 'https://local-ingest.example',
            dashboard_url: 'https://dashboard.example',
            environment: 'test',
          }),
        };
      }
      return { ok: true };
    };

    const { notifySetupComplete } = require('../lib/notify');
    assert.equal(await notifySetupComplete(apiKey), true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://local-ingest.example/v1/plugin/config');
    assert.equal(requests[0].options.headers['x-api-key'], apiKey);
    assert.equal(requests[1].url, 'https://local-ingest.example/v1/setup-complete');
    assert.equal(requests[1].options.headers.Authorization, `Bearer ${apiKey}`);
    assert.deepEqual(Object.keys(JSON.parse(requests[1].options.body)), ['plugin_version']);
  });
}

test('setup notification rejects unsupported API keys without a request', async () => {
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return { ok: true };
  };

  const { notifySetupComplete } = require('../lib/notify');
  assert.equal(await notifySetupComplete('other_key'), false);
  assert.equal(requests, 0);
});
