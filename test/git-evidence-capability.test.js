'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Scopes HOME (for ~/.prism/config.json) and CLAUDE_PLUGIN_DATA, then resets
// the require caches for every module that reads either at load or first
// use, so each test gets an isolated environment and cache.
function withEnv(home, dataDir, action) {
  const previousHome = process.env.HOME;
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.HOME = home;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  for (const name of ['../lib/env', '../lib/config', '../lib/git-evidence-capability']) {
    delete require.cache[require.resolve(name)];
  }
  const restore = () => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previousData;
    for (const name of ['../lib/env', '../lib/config', '../lib/git-evidence-capability']) {
      delete require.cache[require.resolve(name)];
    }
  };
  let result;
  try {
    result = action();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then((value) => { restore(); return value; }, (error) => { restore(); throw error; });
  }
  restore();
  return result;
}

function writeConfig(home, apiKey, ingestUrl) {
  const dir = path.join(home, '.prism');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ apiKey, ingest_url: ingestUrl }));
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function supportedConfigBody() {
  return JSON.stringify({ contracts: { git_evidence: { endpoint: '/v1/git-evidence', versions: ['git-evidence/v1'] } } });
}

test('git_capability_cache_v1: cache file is 0600 in a 0700 directory, named by the binding digest, with a temp+rename publish', async () => {
  const home = tempDir('prism-cap-home-');
  const dataDir = tempDir('prism-cap-data-');
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(supportedConfigBody());
  });
  writeConfig(home, 'prism_capability_test', server.url);
  try {
    await withEnv(home, dataDir, async () => {
      const { refreshCapability } = require('../lib/git-evidence-capability');
      const { bindingDigest } = require('../lib/binding');
      const snapshot = await refreshCapability({ force: true });
      assert.equal(snapshot.state, 'supported');

      const digest = bindingDigest('prism_capability_test', server.url);
      const file = path.join(dataDir, 'runtime', `git-evidence-capability-${digest}.json`);
      const dirStat = fs.statSync(path.join(dataDir, 'runtime'));
      const fileStat = fs.lstatSync(file);
      assert.equal(dirStat.mode & 0o777, 0o700);
      assert.equal(fileStat.mode & 0o777, 0o600);
      assert.ok(fileStat.isFile());
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(!raw.includes('prism_capability_test'));
      assert.ok(!raw.includes(server.url));
    });
  } finally {
    await server.close();
  }
});

test('refresh is skipped inside 5 minutes and performed after', async () => {
  const home = tempDir('prism-cap-home-refresh-');
  const dataDir = tempDir('prism-cap-data-refresh-');
  let calls = 0;
  const server = await startServer((req, res) => {
    calls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(supportedConfigBody());
  });
  writeConfig(home, 'prism_capability_refresh', server.url);
  try {
    await withEnv(home, dataDir, async () => {
      const { refreshCapability, CAPABILITY_REFRESH_INTERVAL_MS } = require('../lib/git-evidence-capability');
      await refreshCapability({ force: true });
      assert.equal(calls, 1);
      await refreshCapability({});
      assert.equal(calls, 1, 'refresh inside the interval must not perform a second request');
      await refreshCapability({ now: Date.now() + CAPABILITY_REFRESH_INTERVAL_MS + 1 });
      assert.equal(calls, 2);
    });
  } finally {
    await server.close();
  }
});

test('a transient failure keeps a prior supported state for up to 1 hour without advancing last_success_at', async () => {
  const home = tempDir('prism-cap-home-transient-');
  const dataDir = tempDir('prism-cap-data-transient-');
  let fail = false;
  const server = await startServer((req, res) => {
    if (fail) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(supportedConfigBody());
  });
  writeConfig(home, 'prism_capability_transient', server.url);
  try {
    await withEnv(home, dataDir, async () => {
      const { refreshCapability, capabilityAllowsEvidence, CAPABILITY_MAX_STALE_MS } = require('../lib/git-evidence-capability');
      const first = await refreshCapability({ force: true });
      assert.equal(first.state, 'supported');
      const lastSuccessAt = first.last_success_at;

      fail = true;
      const now1 = Date.now() + 10 * 60 * 1000;
      const second = await refreshCapability({ force: true, now: now1 });
      assert.equal(second.state, 'supported');
      assert.equal(second.last_success_at, lastSuccessAt);
      assert.equal(capabilityAllowsEvidence(second, now1), true);

      const now2 = Date.parse(lastSuccessAt) + CAPABILITY_MAX_STALE_MS + 1;
      const third = await refreshCapability({ force: true, now: now2 });
      assert.equal(third.last_success_at, lastSuccessAt);
      assert.equal(capabilityAllowsEvidence(third, now2), false, 'gate closes with no further request once stale');
    });
  } finally {
    await server.close();
  }
});

test('an authenticated 200 without the contract flips to unsupported, ignoring a prior supported value', async () => {
  const home = tempDir('prism-cap-home-unsupported-');
  const dataDir = tempDir('prism-cap-data-unsupported-');
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contracts: {} }));
  });
  writeConfig(home, 'prism_capability_unsupported', server.url);
  try {
    await withEnv(home, dataDir, async () => {
      const { refreshCapability, capabilityAllowsEvidence } = require('../lib/git-evidence-capability');
      const snapshot = await refreshCapability({ force: true });
      assert.equal(snapshot.state, 'unsupported');
      assert.equal(capabilityAllowsEvidence(snapshot), false);
    });
  } finally {
    await server.close();
  }
});

test('401/403 -> auth_error; invalid JSON, oversize body, 204, 302, 418 -> protocol_error; all fail closed', async () => {
  const home = tempDir('prism-cap-home-errors-');
  const dataDir = tempDir('prism-cap-data-errors-');
  let mode = 'auth';
  const server = await startServer((req, res) => {
    if (mode === 'auth') { res.writeHead(401); res.end(); return; }
    if (mode === 'invalid-json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not json'); return; }
    if (mode === 'oversize') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ padding: 'x'.repeat(20000) }));
      return;
    }
    if (mode === '204') { res.writeHead(204); res.end(); return; }
    if (mode === '302') { res.writeHead(302, { Location: '/' }); res.end(); return; }
    if (mode === '418') { res.writeHead(418); res.end(); return; }
  });
  writeConfig(home, 'prism_capability_errors', server.url);
  try {
    for (const [testMode, expected] of [
      ['auth', 'auth_error'],
      ['invalid-json', 'protocol_error'],
      ['oversize', 'protocol_error'],
      ['204', 'protocol_error'],
      ['302', 'protocol_error'],
      ['418', 'protocol_error'],
    ]) {
      mode = testMode;
      // eslint-disable-next-line no-await-in-loop
      await withEnv(home, dataDir, async () => {
        const { refreshCapability, capabilityAllowsEvidence } = require('../lib/git-evidence-capability');
        const snapshot = await refreshCapability({ force: true });
        assert.equal(snapshot.state, expected, testMode);
        assert.equal(capabilityAllowsEvidence(snapshot), false, testMode);
      });
    }
  } finally {
    await server.close();
  }
});

test('a cache file that is a symlink, oversize, wrong-schema, or bound to a different digest is ignored and the gate is closed', async () => {
  const home = tempDir('prism-cap-home-cache-shapes-');
  const dataDir = tempDir('prism-cap-data-cache-shapes-');
  writeConfig(home, 'prism_capability_cache_shapes', 'https://ingest.example.test');
  await withEnv(home, dataDir, () => {
    const { readCapabilityCache } = require('../lib/git-evidence-capability');
    const { bindingDigest } = require('../lib/binding');
    const digest = bindingDigest('prism_capability_cache_shapes', 'https://ingest.example.test');
    const dir = path.join(dataDir, 'runtime');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `git-evidence-capability-${digest}.json`);

    const validShape = {
      schema_version: 'git-evidence-capability-cache/v1', binding_digest: digest, checked_at: new Date().toISOString(), last_success_at: new Date().toISOString(), state: 'supported', endpoint: '/v1/git-evidence', versions: ['git-evidence/v1'],
    };

    // Oversize.
    fs.writeFileSync(file, JSON.stringify({ ...validShape, padding: 'x'.repeat(20000) }), { mode: 0o600 });
    assert.equal(readCapabilityCache(), null);

    // Wrong schema.
    fs.writeFileSync(file, JSON.stringify({ ...validShape, schema_version: 'other/v1' }), { mode: 0o600 });
    assert.equal(readCapabilityCache(), null);

    // Different binding digest.
    fs.writeFileSync(file, JSON.stringify({ ...validShape, binding_digest: 'f'.repeat(32) }), { mode: 0o600 });
    assert.equal(readCapabilityCache(), null);

    // Symlink target instead of a regular file.
    const target = path.join(dir, 'target.json');
    fs.writeFileSync(target, JSON.stringify(validShape), { mode: 0o600 });
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
    assert.equal(readCapabilityCache(), null);
  });
});

test('capabilityAllowsEvidence gate: missing, stale, unsupported, withdrawn, or protocol_error all close it', async () => {
  const home = tempDir('prism-cap-home-fleet-');
  const dataDir = tempDir('prism-cap-data-fleet-');
  writeConfig(home, 'prism_capability_fleet', 'https://ingest.example.test');
  await withEnv(home, dataDir, () => {
    const { capabilityAllowsEvidence } = require('../lib/git-evidence-capability');
    for (const state of ['unsupported', 'withdrawn', 'auth_error', 'protocol_error']) {
      const snapshot = {
        schema_version: 'git-evidence-capability-cache/v1',
        binding_digest: require('../lib/binding').bindingDigest('prism_capability_fleet', 'https://ingest.example.test'),
        checked_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        state,
        endpoint: '/v1/git-evidence',
        versions: ['git-evidence/v1'],
      };
      assert.equal(capabilityAllowsEvidence(snapshot), false, state);
    }
    assert.equal(capabilityAllowsEvidence(null), false, 'missing cache');
  });
});

test('markCapabilityWithdrawn/AuthError/ProtocolError publish delivery-driven transitions without advancing last_success_at', async () => {
  const home = tempDir('prism-cap-home-transitions-');
  const dataDir = tempDir('prism-cap-data-transitions-');
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(supportedConfigBody());
  });
  writeConfig(home, 'prism_capability_transitions', server.url);
  try {
    await withEnv(home, dataDir, async () => {
      const capability = require('../lib/git-evidence-capability');
      const supported = await capability.refreshCapability({ force: true });
      assert.equal(supported.state, 'supported');

      assert.equal(capability.markCapabilityWithdrawn(), true);
      let snapshot = capability.readCapabilityCache();
      assert.equal(snapshot.state, 'withdrawn');
      assert.equal(snapshot.last_success_at, supported.last_success_at);
      assert.equal(capability.capabilityAllowsEvidence(snapshot), false);

      assert.equal(capability.markCapabilityAuthError(), true);
      snapshot = capability.readCapabilityCache();
      assert.equal(snapshot.state, 'auth_error');

      assert.equal(capability.markCapabilityProtocolError(), true);
      snapshot = capability.readCapabilityCache();
      assert.equal(snapshot.state, 'protocol_error');
    });
  } finally {
    await server.close();
  }
});
