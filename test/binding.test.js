const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const binding = require('../lib/binding');
const helper = require('../lib/otel-headers-helper');

const KEY = 'opaque key with no required prefix';
const URL_DEV = 'https://ingest.dev.example';
const URL_PROD = 'https://ingest.example';
const MODULE_PATHS = ['../lib/config', '../lib/env'];

let homeDir;
let originalHome;

function configFile(dir = homeDir) {
  return path.join(dir, '.prism', 'config.json');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) delete require.cache[require.resolve(modulePath)];
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-binding-test-'));
  originalHome = { present: Object.hasOwn(process.env, 'HOME'), value: process.env.HOME };
  process.env.HOME = homeDir;
  clearModules();
});

afterEach(() => {
  if (originalHome.present) process.env.HOME = originalHome.value;
  else delete process.env.HOME;
  clearModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('the runtime and the standalone helper compute one identical digest rule', () => {
  const cases = [
    [KEY, URL_DEV],
    [KEY, `${URL_DEV}/`],
    [KEY, `${URL_DEV}///`],
    [KEY, URL_DEV.toUpperCase()],
    [KEY, URL_PROD],
    [`${KEY} other`, URL_DEV],
    [KEY, 'http://127.0.0.1:9005/base'],
    ['', URL_DEV],
    [KEY, ''],
    [null, URL_DEV],
    [KEY, undefined],
  ];

  for (const [apiKey, ingestUrl] of cases) {
    assert.equal(
      helper.bindingDigest(apiKey, ingestUrl),
      binding.bindingDigest(apiKey, ingestUrl),
      `digest rule diverged for ${JSON.stringify([apiKey, ingestUrl])}`,
    );
  }
});

test('the digest folds trailing slashes and case but separates key and destination', () => {
  const base = binding.bindingDigest(KEY, URL_DEV);

  assert.equal(base.length, binding.BINDING_DIGEST_LENGTH);
  assert.match(base, /^[0-9a-f]+$/);
  assert.equal(binding.bindingDigest(KEY, `${URL_DEV}/`), base);
  assert.equal(binding.bindingDigest(KEY, `${URL_DEV}///`), base);
  assert.equal(binding.bindingDigest(KEY, 'HTTPS://INGEST.DEV.EXAMPLE'), base);

  assert.notEqual(binding.bindingDigest(KEY, URL_PROD), base);
  assert.notEqual(binding.bindingDigest(KEY, `${URL_DEV}/base`), base);
  assert.notEqual(binding.bindingDigest(`${KEY}!`, URL_DEV), base);

  // The separator keeps a key/URL split from colliding with a shifted split.
  assert.notEqual(
    binding.bindingDigest('a', `\nb${URL_DEV.slice(0, 0)}`),
    binding.bindingDigest('a\nb', ''),
  );

  for (const [apiKey, ingestUrl] of [['', URL_DEV], [KEY, ''], [null, URL_DEV], [KEY, 7]]) {
    assert.equal(binding.bindingDigest(apiKey, ingestUrl), null);
  }
});

test('buildBinding seals the verified pair and refuses an unusable one', () => {
  const now = new Date('2026-07-27T00:00:00.000Z');
  const sealed = binding.buildBinding({ apiKey: KEY, ingestUrl: `${URL_DEV}/`, now });

  assert.deepEqual(sealed, {
    digest: binding.bindingDigest(KEY, URL_DEV),
    host: 'ingest.dev.example',
    bound_at: '2026-07-27T00:00:00.000Z',
  });

  assert.equal(binding.buildBinding({ apiKey: '', ingestUrl: URL_DEV }), null);
  assert.equal(binding.buildBinding({ apiKey: KEY, ingestUrl: '' }), null);
  assert.equal(binding.buildBinding({}), null);
  assert.equal(binding.buildBinding(), null);
  assert.equal(binding.buildBinding({ apiKey: KEY, ingestUrl: 'not a url' }).host, null);
});

test('verifyBinding fails open without a seal and fails closed once one side changes', () => {
  const sealed = binding.buildBinding({ apiKey: KEY, ingestUrl: URL_DEV });

  assert.deepEqual(binding.verifyBinding({ apiKey: KEY, ingest_url: URL_DEV, binding: sealed }), {
    status: 'ok',
    boundHost: 'ingest.dev.example',
    currentHost: 'ingest.dev.example',
  });

  // A trailing slash or case change is the same pair, not a new one.
  assert.equal(
    binding.verifyBinding({ apiKey: KEY, ingest_url: `${URL_DEV}/`, binding: sealed }).status,
    'ok',
  );

  assert.deepEqual(binding.verifyBinding({ apiKey: KEY, ingest_url: URL_PROD, binding: sealed }), {
    status: 'mismatch',
    boundHost: 'ingest.dev.example',
    currentHost: 'ingest.example',
  });
  assert.equal(
    binding.verifyBinding({ apiKey: `${KEY}!`, ingest_url: URL_DEV, binding: sealed }).status,
    'mismatch',
  );
  assert.equal(
    binding.verifyBinding({ apiKey: '', ingest_url: URL_DEV, binding: sealed }).status,
    'mismatch',
  );

  for (const stored of [undefined, null, {}, [], 'digest', { digest: '' }, { digest: 7 }]) {
    assert.equal(
      binding.verifyBinding({ apiKey: KEY, ingest_url: URL_DEV, binding: stored }).status,
      'unbound',
      `unexpected status for stored binding ${JSON.stringify(stored)}`,
    );
  }
  assert.deepEqual(binding.verifyBinding(null), {
    status: 'unbound',
    boundHost: null,
    currentHost: null,
  });
});

test('an unsealed or matching pair keeps the runtime key available', () => {
  writeJson(configFile(), { apiKey: KEY, ingest_url: URL_DEV });
  assert.equal(require('../lib/env').API_KEY, KEY);
  assert.equal(require('../lib/env').BINDING_STATUS, 'unbound');

  clearModules();
  writeJson(configFile(), {
    apiKey: KEY,
    ingest_url: URL_DEV,
    binding: binding.buildBinding({ apiKey: KEY, ingestUrl: URL_DEV }),
  });
  const runtime = require('../lib/env');
  assert.equal(runtime.API_KEY, KEY);
  assert.equal(runtime.BINDING_STATUS, 'ok');
  assert.equal(runtime.INGEST_URL, URL_DEV);
});

test('a repointed destination withholds the runtime key while the route stays visible', () => {
  writeJson(configFile(), {
    apiKey: KEY,
    ingest_url: URL_PROD,
    binding: binding.buildBinding({ apiKey: KEY, ingestUrl: URL_DEV }),
  });

  const runtime = require('../lib/env');

  assert.equal(runtime.API_KEY, '');
  assert.equal(runtime.BINDING_STATUS, 'mismatch');
  assert.equal(runtime.BINDING_BOUND_HOST, 'ingest.dev.example');
  assert.equal(runtime.BINDING_CURRENT_HOST, 'ingest.example');
  // The stored route is still reported so status and doctor can explain the pair.
  assert.equal(runtime.INGEST_URL, URL_PROD);
  assert.equal(require('../lib/config').getConfig().apiKey, KEY);
});

test('the OTEL headers helper emits for an unsealed or matching pair only', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-binding-helper-data-'));
  try {
    writeJson(configFile(), { apiKey: KEY, ingest_url: URL_DEV });
    assert.deepEqual(helper.buildHeaders({ homeDir, dataDir }), { 'x-api-key': KEY });

    writeJson(configFile(), {
      apiKey: KEY,
      ingest_url: URL_DEV,
      binding: binding.buildBinding({ apiKey: KEY, ingestUrl: `${URL_DEV}/` }),
    });
    assert.deepEqual(helper.buildHeaders({ homeDir, dataDir }), { 'x-api-key': KEY });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the OTEL headers helper refuses to emit a repointed pair', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-binding-helper-mismatch-'));
  try {
    writeJson(configFile(), {
      apiKey: KEY,
      ingest_url: URL_PROD,
      binding: binding.buildBinding({ apiKey: KEY, ingestUrl: URL_DEV }),
    });

    assert.throws(
      () => helper.buildHeaders({ homeDir, dataDir }),
      /not bound to the configured ingest URL/,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
