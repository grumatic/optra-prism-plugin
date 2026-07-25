const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  CHECK_INTERVAL_MS,
  MARKETPLACE_URL,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  activeVersionPathFor,
  cachePathFor,
  checkForPluginUpdate,
  compareStableSemVer,
  defaultRequest,
  isStableSemVer,
  marketplaceVersion,
  parseStableSemVer,
  readActiveVersion,
  readCurrentPluginVersion,
  readUpdateCache,
  writeActiveVersion,
  writeUpdateCache,
} = require('../lib/plugin-update');

const NOW_MS = Date.parse('2026-07-25T03:04:05.678Z');
const NOW_ISO = '2026-07-25T03:04:05.678Z';

function temporaryDirectory(t, prefix = 'prism-plugin-update-test-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeManifest(pluginRoot, version) {
  const directory = path.join(pluginRoot, '.claude-plugin');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ version }));
}

function oldCache(overrides = {}) {
  return {
    checkedAt: '2026-07-23T00:00:00.000Z',
    lastSuccessAt: '2026-07-23T00:00:00.000Z',
    etag: '"known-good"',
    latestVersion: '1.4.0',
    ...overrides,
  };
}

function marketplaceBody(version = '1.4.0', extra = {}) {
  return JSON.stringify({
    name: 'optra-prism',
    plugins: [
      { name: 'unrelated', version: '99.0.0' },
      { name: 'prism', version, ...extra },
    ],
  });
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

test('strict stable SemVer accepts only canonical major.minor.patch values', () => {
  for (const value of ['0.0.0', '1.2.3', '10.20.300', `${'9'.repeat(100)}.2.3`]) {
    assert.equal(isStableSemVer(value), true, value);
  }
  for (const value of [
    null,
    123,
    '',
    ' 1.2.3',
    '1.2.3\n',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2',
    '1.2.3.4',
    '1.2.3-beta.1',
    '1.2.3+build.1',
    '-1.2.3',
  ]) {
    assert.equal(isStableSemVer(value), false, String(value));
  }
  assert.deepEqual(parseStableSemVer('10.20.300'), [10n, 20n, 300n]);
});

test('strict comparison is numeric, supports large components, and rejects invalid input', () => {
  assert.equal(compareStableSemVer('1.10.0', '1.9.99'), 1);
  assert.equal(compareStableSemVer('2.0.0', '10.0.0'), -1);
  assert.equal(compareStableSemVer('1.2.3', '1.2.3'), 0);
  assert.equal(compareStableSemVer(`${'9'.repeat(100)}.0.0`, '999.999.999'), 1);
  assert.equal(compareStableSemVer('v1.2.3', '1.2.3'), null);
  assert.equal(compareStableSemVer('1.2.3', '1.2.3-beta.1'), null);
});

test('manifest reads reuse plugin-version parsing and then enforce stable SemVer', (t) => {
  const pluginRoot = temporaryDirectory(t);
  writeManifest(pluginRoot, '1.2.3');
  assert.equal(readCurrentPluginVersion({ pluginRoot }), '1.2.3');

  writeManifest(pluginRoot, 'v1.2.3');
  assert.equal(readCurrentPluginVersion({ pluginRoot }), null);

  const alternateManifest = path.join(pluginRoot, 'alternate.json');
  fs.writeFileSync(alternateManifest, JSON.stringify({ version: '1.2.4-beta.1' }));
  assert.equal(readCurrentPluginVersion({ manifestPath: alternateManifest }), null);
  assert.equal(readCurrentPluginVersion({ manifestPath: path.join(pluginRoot, 'missing.json') }), null);
});

test('marketplace parsing selects prism and rejects unstable or malformed versions', () => {
  assert.equal(marketplaceVersion(Buffer.from(marketplaceBody('2.3.4'))), '2.3.4');
  assert.equal(
    marketplaceVersion(Buffer.from(JSON.stringify({
      plugins: [
        { name: 'other', version: '9.9.9' },
        { name: 'prism', version: '2.0.0-beta.1' },
      ],
    }))),
    null,
  );
  for (const value of [
    Buffer.from('{'),
    Buffer.from('[]'),
    Buffer.from('{}'),
    Buffer.from('{"plugins":{}}'),
    Buffer.from('{"plugins":[{"name":"other","version":"1.0.0"}]}'),
    Buffer.from('{"plugins":[{"name":"prism","version":"1.0.0"},{"name":"prism","version":"2.0.0"}]}'),
  ]) {
    assert.equal(marketplaceVersion(value), null);
  }
});

test('active version helpers validate, atomically publish, and use mode 0600', (t) => {
  const dataDir = temporaryDirectory(t);
  const file = activeVersionPathFor(dataDir);

  assert.equal(readActiveVersion(dataDir), null);
  assert.equal(writeActiveVersion(dataDir, '1.2.3'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '1.2.3');
  assert.equal(readActiveVersion(dataDir), '1.2.3');
  assert.equal(mode(file), 0o600);
  assert.deepEqual(fs.readdirSync(dataDir), ['last-version.txt']);

  for (const invalid of ['v1.2.4', '1.2.4\n', '1.2.4-beta.1', '01.2.4']) {
    assert.equal(writeActiveVersion(dataDir, invalid), false, invalid);
    assert.equal(readActiveVersion(dataDir), '1.2.3');
  }

  fs.writeFileSync(file, '1.2.4\n');
  assert.equal(readActiveVersion(dataDir), null);
});

test('active version publication preserves the previous file when rename fails', (t) => {
  const dataDir = temporaryDirectory(t);
  assert.equal(writeActiveVersion(dataDir, '1.0.0'), true);

  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated rename failure');
  };
  try {
    assert.equal(writeActiveVersion(dataDir, '2.0.0'), false);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(readActiveVersion(dataDir), '1.0.0');
  assert.deepEqual(fs.readdirSync(dataDir), ['last-version.txt']);
});

test('active version reads reject symlinks and oversized files', (t) => {
  const dataDir = temporaryDirectory(t);
  const target = path.join(dataDir, 'target.txt');
  fs.writeFileSync(target, '1.2.3');
  fs.symlinkSync(target, activeVersionPathFor(dataDir));
  assert.equal(readActiveVersion(dataDir), null);

  fs.unlinkSync(activeVersionPathFor(dataDir));
  fs.writeFileSync(activeVersionPathFor(dataDir), '1'.repeat(129));
  assert.equal(readActiveVersion(dataDir), null);
});

test('cache helpers atomically persist the exact schema with mode 0600', (t) => {
  const dataDir = temporaryDirectory(t);
  const input = {
    checkedAt: NOW_ISO,
    lastSuccessAt: '2026-07-24T03:04:05Z',
    etag: '"release-1"',
    latestVersion: '2.0.0',
    ignored: 'not persisted',
  };

  assert.equal(writeUpdateCache(dataDir, input), true);
  assert.deepEqual(readUpdateCache(dataDir), {
    checkedAt: NOW_ISO,
    lastSuccessAt: '2026-07-24T03:04:05.000Z',
    etag: '"release-1"',
    latestVersion: '2.0.0',
  });
  assert.equal(mode(cachePathFor(dataDir)), 0o600);
  assert.deepEqual(fs.readdirSync(dataDir), ['update-check.json']);
  assert.equal(writeUpdateCache(dataDir, { ...input, checkedAt: 'invalid' }), false);
});

test('cache reads fail open and retain independently valid last-known-good fields', (t) => {
  const dataDir = temporaryDirectory(t);
  const file = cachePathFor(dataDir);
  fs.writeFileSync(file, JSON.stringify({
    checkedAt: 'invalid',
    lastSuccessAt: '2026-07-24T03:04:05Z',
    etag: '"bad"\r\nInjected: true',
    latestVersion: '2.0.0',
  }));
  assert.deepEqual(readUpdateCache(dataDir), {
    checkedAt: null,
    lastSuccessAt: '2026-07-24T03:04:05.000Z',
    etag: null,
    latestVersion: '2.0.0',
  });

  fs.writeFileSync(file, '{');
  assert.deepEqual(readUpdateCache(dataDir), {
    checkedAt: null,
    lastSuccessAt: null,
    etag: null,
    latestVersion: null,
  });
});

test('a fresh cache skips the request and still compares the cached version', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.2.3');
  assert.equal(writeUpdateCache(dataDir, oldCache({
    checkedAt: new Date(NOW_MS - 999).toISOString(),
    latestVersion: '1.3.0',
  })), true);

  let requests = 0;
  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: () => NOW_MS,
    interval: 1000,
    requestFn: async () => {
      requests += 1;
      throw new Error('must not run');
    },
  });

  assert.equal(requests, 0);
  assert.deepEqual({
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    updateAvailable: result.updateAvailable,
    checked: result.checked,
    cacheFresh: result.cacheFresh,
    status: result.status,
  }, {
    currentVersion: '1.2.3',
    latestVersion: '1.3.0',
    updateAvailable: true,
    checked: false,
    cacheFresh: true,
    status: 'cache-fresh',
  });
});

test('a 200 response uses the fixed request contract and publishes the selected version', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.2.3');
  let requestCount = 0;

  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_ISO,
    requestFn: async (url, options) => {
      requestCount += 1;
      assert.equal(url, MARKETPLACE_URL);
      assert.equal(options.method, 'GET');
      assert.equal(options.timeoutMs, REQUEST_TIMEOUT_MS);
      assert.equal(options.maxBytes, MAX_RESPONSE_BYTES);
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      return {
        statusCode: 200,
        headers: { etag: '"release-2"' },
        body: Buffer.from(marketplaceBody('1.3.0')),
      };
    },
  });

  assert.equal(requestCount, 1);
  assert.deepEqual({
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    updateAvailable: result.updateAvailable,
    checked: result.checked,
    cacheFresh: result.cacheFresh,
    status: result.status,
  }, {
    currentVersion: '1.2.3',
    latestVersion: '1.3.0',
    updateAvailable: true,
    checked: true,
    cacheFresh: false,
    status: 'updated-cache',
  });
  assert.deepEqual(readUpdateCache(dataDir), {
    checkedAt: NOW_ISO,
    lastSuccessAt: NOW_ISO,
    etag: '"release-2"',
    latestVersion: '1.3.0',
  });
});

test('a stale cache sends If-None-Match and 304 refreshes success metadata', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.4.0');
  assert.equal(writeUpdateCache(dataDir, oldCache()), true);

  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: () => NOW_MS,
    requestFn: async (url, options) => {
      assert.equal(url, MARKETPLACE_URL);
      assert.equal(options.headers['If-None-Match'], '"known-good"');
      return {
        status: 304,
        headers: { ETag: '"known-good-refreshed"' },
        body: '',
      };
    },
  });

  assert.equal(result.status, 'not-modified');
  assert.equal(result.checked, true);
  assert.equal(result.latestVersion, '1.4.0');
  assert.equal(result.updateAvailable, false);
  assert.deepEqual(readUpdateCache(dataDir), {
    checkedAt: NOW_ISO,
    lastSuccessAt: NOW_ISO,
    etag: '"known-good-refreshed"',
    latestVersion: '1.4.0',
  });
});

test('the default 24 hour TTL expires at the boundary', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.0.0');
  assert.equal(writeUpdateCache(dataDir, oldCache({
    checkedAt: new Date(NOW_MS - CHECK_INTERVAL_MS).toISOString(),
  })), true);
  let requests = 0;

  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS,
    requestFn: async () => {
      requests += 1;
      return { statusCode: 304, headers: {}, body: '' };
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.checked, true);
});

test('every attempted failure advances checkedAt and retains last-known-good data', async (t) => {
  const cases = [
    ['request throw', async () => { throw new Error('offline'); }, 'request-failed'],
    ['unexpected status', async () => ({ statusCode: 503, headers: {}, body: '' }), 'unexpected-status'],
    ['missing body', async () => ({ statusCode: 200, headers: {} }), 'invalid-response'],
    ['oversized body', async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(MAX_RESPONSE_BYTES + 1),
    }), 'response-too-large'],
    ['malformed JSON', async () => ({ statusCode: 200, headers: {}, body: '{' }), 'invalid-marketplace'],
    ['missing prism', async () => ({
      statusCode: 200,
      headers: {},
      body: '{"plugins":[{"name":"other","version":"9.0.0"}]}',
    }), 'invalid-marketplace'],
    ['prerelease', async () => ({
      statusCode: 200,
      headers: {},
      body: marketplaceBody('2.0.0-beta.1'),
    }), 'invalid-marketplace'],
    ['leading zero', async () => ({
      statusCode: 200,
      headers: {},
      body: marketplaceBody('02.0.0'),
    }), 'invalid-marketplace'],
  ];

  for (const [name, requestFn, expectedStatus] of cases) {
    await t.test(name, async (t) => {
      const root = temporaryDirectory(t);
      const pluginRoot = path.join(root, 'plugin');
      const dataDir = path.join(root, 'data');
      writeManifest(pluginRoot, '1.3.0');
      assert.equal(writeUpdateCache(dataDir, oldCache()), true);

      const result = await checkForPluginUpdate({
        pluginRoot,
        dataDir,
        now: NOW_MS,
        requestFn,
      });

      assert.equal(result.status, expectedStatus);
      assert.equal(result.checked, true);
      assert.equal(result.updateAvailable, true);
      assert.deepEqual(result.cache, {
        checkedAt: NOW_ISO,
        lastSuccessAt: '2026-07-23T00:00:00.000Z',
        etag: '"known-good"',
        latestVersion: '1.4.0',
      });
      assert.deepEqual(readUpdateCache(dataDir), result.cache);
    });
  }
});

test('a failed attempt is TTL-cached to prevent repeated startup requests', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.3.0');
  let requests = 0;
  const requestFn = async () => {
    requests += 1;
    throw new Error('offline');
  };

  const first = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS,
    requestFn,
  });
  const second = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS + 1000,
    requestFn,
  });

  assert.equal(requests, 1);
  assert.equal(first.status, 'request-failed');
  assert.equal(first.checked, true);
  assert.equal(second.status, 'cache-fresh');
  assert.equal(second.checked, false);
});

test('304 without a known version is an attempted failure and remains fail-open', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.0.0');
  assert.equal(writeUpdateCache(dataDir, oldCache({
    lastSuccessAt: null,
    latestVersion: null,
  })), true);

  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS,
    requestFn: async () => ({ statusCode: 304, headers: {}, body: '' }),
  });

  assert.equal(result.status, 'invalid-not-modified');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.cache.checkedAt, NOW_ISO);
  assert.equal(result.cache.lastSuccessAt, null);
  assert.equal(result.cache.latestVersion, null);
  assert.deepEqual(readUpdateCache(dataDir), result.cache);
});

test('an ETag without a known version is not sent and can recover through 200', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.0.0');
  assert.equal(writeUpdateCache(dataDir, oldCache({
    lastSuccessAt: null,
    latestVersion: null,
  })), true);

  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS,
    requestFn: async (url, options) => {
      assert.equal(url, MARKETPLACE_URL);
      assert.equal(options.headers['If-None-Match'], undefined);
      return {
        statusCode: 200,
        headers: { etag: '"recovered"' },
        body: marketplaceBody('2.0.0'),
      };
    },
  });

  assert.equal(result.status, 'updated-cache');
  assert.equal(result.latestVersion, '2.0.0');
  assert.equal(result.cache.etag, '"recovered"');
});

test('an exact 16 KiB response is accepted while larger injected bodies are rejected', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, '1.0.0');

  const base = JSON.stringify({
    plugins: [{ name: 'prism', version: '2.0.0' }],
    padding: '',
  });
  const exactBody = JSON.stringify({
    plugins: [{ name: 'prism', version: '2.0.0' }],
    padding: 'x'.repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(base)),
  });
  assert.equal(Buffer.byteLength(exactBody), MAX_RESPONSE_BYTES);

  const accepted = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS,
    interval: 0,
    requestFn: async () => ({ statusCode: 200, headers: {}, body: exactBody }),
  });
  assert.equal(accepted.status, 'updated-cache');
  assert.equal(accepted.latestVersion, '2.0.0');

  const rejected = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS + 1,
    interval: 0,
    requestFn: async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(MAX_RESPONSE_BYTES + 1),
    }),
  });
  assert.equal(rejected.status, 'response-too-large');
  assert.equal(rejected.latestVersion, '2.0.0');
});

test('invalid current versions never produce an update recommendation', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const dataDir = path.join(root, 'data');
  writeManifest(pluginRoot, 'v1.0.0');

  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS,
    requestFn: async () => ({
      statusCode: 200,
      headers: {},
      body: marketplaceBody('2.0.0'),
    }),
  });
  assert.equal(result.currentVersion, null);
  assert.equal(result.latestVersion, '2.0.0');
  assert.equal(result.updateAvailable, false);
});

test('cache publication errors remain fail-open without throwing', async (t) => {
  const root = temporaryDirectory(t);
  const pluginRoot = path.join(root, 'plugin');
  const blockingFile = path.join(root, 'not-a-directory');
  const dataDir = path.join(blockingFile, 'data');
  writeManifest(pluginRoot, '1.0.0');
  fs.writeFileSync(blockingFile, 'block directory creation');

  const result = await checkForPluginUpdate({
    pluginRoot,
    dataDir,
    now: NOW_MS,
    requestFn: async () => ({
      statusCode: 200,
      headers: {},
      body: marketplaceBody('2.0.0'),
    }),
  });

  assert.equal(result.status, 'cache-write-failed');
  assert.equal(result.checked, true);
  assert.equal(result.latestVersion, '2.0.0');
  assert.equal(result.updateAvailable, true);
});

test('empty and relative data directories fail open without attempting a request', async () => {
  for (const dataDir of ['', '.', 'relative/plugin-data']) {
    let requests = 0;
    const result = await checkForPluginUpdate({
      dataDir,
      requestFn: async () => {
        requests += 1;
        return { statusCode: 200, headers: {}, body: marketplaceBody('2.0.0') };
      },
    });

    assert.equal(requests, 0, dataDir);
    assert.equal(result.status, 'invalid-data-dir', dataDir);
    assert.equal(result.checked, false, dataDir);
    assert.equal(result.updateAvailable, false, dataDir);
    assert.equal(writeActiveVersion(dataDir, '1.2.3'), false, dataDir);
    assert.equal(writeUpdateCache(dataDir, oldCache()), false, dataDir);
  }
});

test('default transport rejects non-HTTPS URLs before making a network request', async () => {
  await assert.rejects(
    defaultRequest('http://example.com/marketplace.json'),
    /https-required/,
  );
  await assert.rejects(
    defaultRequest('not a URL'),
    /invalid-url/,
  );
});
