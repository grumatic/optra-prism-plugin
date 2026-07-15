const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const config = require('../lib/config');
const originalEnsureCache = config.ensureCache;

function loadSetup() {
  delete require.cache[require.resolve('../lib/setup')];
  return require('../lib/setup');
}

function captureOutput() {
  const logs = [];
  const errors = [];
  return {
    output: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
    logs,
    errors,
  };
}

afterEach(() => {
  config.ensureCache = originalEnsureCache;
  delete require.cache[require.resolve('../lib/setup')];
});

test('setup cache action preserves an opaque supported API key', async () => {
  const apiKey = 'gck_\'"`;\nopaque shell value';
  let receivedApiKey;
  config.ensureCache = async (value) => {
    receivedApiKey = value;
    return { source: 'server', ingest_url: 'https://ingest.example' };
  };
  const captured = captureOutput();
  const { cacheConfig } = loadSetup();

  assert.equal(await cacheConfig(apiKey, captured.output), 0);
  assert.equal(receivedApiKey, apiKey);
  assert.deepEqual(captured.errors, []);
});

test('setup cache action fails on credential rejection without reporting fallback', async () => {
  config.ensureCache = async () => ({
    source: 'auth-error',
    auth_status: 403,
    ingest_url: 'https://ingest.optra-prism.com',
  });
  const captured = captureOutput();
  const { cacheConfig } = loadSetup();

  assert.equal(await cacheConfig('prism_rejected', captured.output), 2);
  assert.deepEqual(captured.logs, []);
  assert.deepEqual(captured.errors, [
    'ERROR: config endpoint rejected the API key (HTTP 403).',
  ]);
});

test('setup cache action retains network fallback behavior', async () => {
  config.ensureCache = async () => ({
    source: 'fallback',
    ingest_url: 'https://ingest.optra-prism.com',
  });
  const captured = captureOutput();
  const { cacheConfig } = loadSetup();

  assert.equal(await cacheConfig('prism_offline', captured.output), 0);
  assert.match(captured.logs[0], /Config cached \(fallback\)/);
  assert.match(captured.logs[1], /config endpoint unreachable/);
  assert.deepEqual(captured.errors, []);
});
