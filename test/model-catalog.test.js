const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { afterEach, test } = require('node:test');
const {
  CATALOG_SCHEMA_VERSION,
  cachePathFor,
  timestamp,
  validateSnapshot,
  refreshCatalog,
  loadCatalog,
  adaptModelId,
  rateFor,
} = require('../lib/model-catalog');

const dirs = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-model-catalog-'));
  dirs.push(dir);
  return dir;
}

function snapshot(revision = 7) {
  return {
    schema_version: 1,
    catalog_revision: revision,
    checksum_sha256: 'a'.repeat(64),
    exact_lookups: [{
      external_model_id: 'claude-test',
      list_rates: [{
        effective_from: '2026-01-01T00:00:00Z',
        effective_to: '2026-07-01T00:00:00Z',
        rate: { input: 1, output: 2, cache_read: 0.1, cache_write_5m: 0.2 },
      }, {
        effective_from: '2026-07-01T00:00:00Z',
        effective_to: null,
        rate: { input: 3, output: 4, cache_read: 0.3, cache_write_5m: 0.4 },
      }],
    }],
  };
}

async function server(handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${instance.address().port}`,
    close: () => new Promise((resolve) => instance.close(resolve)),
  };
}

function writeKnownGood(dir, url, revision = 1) {
  const value = snapshot(revision);
  fs.writeFileSync(cachePathFor(dir, url, revision), JSON.stringify(value));
  return value;
}

function childRefresh(options) {
  const modulePath = path.resolve(__dirname, '../lib/model-catalog');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', [
      'const { refreshCatalog } = require(process.env.MODEL_CATALOG_MODULE);',
      'refreshCatalog(JSON.parse(process.env.MODEL_CATALOG_OPTIONS))',
      '  .then((result) => process.stdout.write(result))',
      '  .catch((error) => { process.stderr.write(error.stack); process.exitCode = 1; });',
    ].join('\n')], {
      env: {
        ...process.env,
        MODEL_CATALOG_MODULE: modulePath,
        MODEL_CATALOG_OPTIONS: JSON.stringify(options),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`refresh child exited ${code ?? signal}: ${stderr}`));
    });
  });
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('validateSnapshot accepts complete snapshots and rejects malformed structures', () => {
  assert.deepEqual(validateSnapshot(snapshot()), snapshot());
  const invalid = (mutate) => {
    const value = snapshot();
    mutate(value);
    assert.equal(validateSnapshot(value), null);
  };
  invalid((value) => { value.schema_version = 2; });
  invalid((value) => { value.catalog_revision = -0; });
  invalid((value) => { value.checksum_sha256 = 'not-a-checksum'; });
  invalid((value) => { value.exact_lookups[0].list_rates[0].effective_from = 'yesterday'; });
  invalid((value) => { value.exact_lookups[0].list_rates[0].effective_from = '2026-02-30T00:00:00Z'; });
  invalid((value) => { value.exact_lookups[0].list_rates[0].rate.input = -1; });
  invalid((value) => { delete value.exact_lookups[0].list_rates[0].rate.cache_read; });
  invalid((value) => { delete value.exact_lookups[0].list_rates[0].rate; });
  invalid((value) => { value.exact_lookups[0].list_rates[0].unpriced_reason = 'ambiguous'; });
});

test('adaptModelId strips only one supported lower-case context suffix', () => {
  assert.deepEqual(adaptModelId('model[1m]'), { raw: 'model[1m]', lookupKey: 'model', context1m: true });
  assert.deepEqual(adaptModelId('model [1m]'), { raw: 'model [1m]', lookupKey: 'model', context1m: true });
  assert.deepEqual(adaptModelId('model[1M]'), { raw: 'model[1M]', lookupKey: 'model[1M]', context1m: false });
  assert.deepEqual(adaptModelId('model[1m][1m]'), { raw: 'model[1m][1m]', lookupKey: 'model[1m]', context1m: true });
  assert.equal(adaptModelId(null), null);
});

test('timestamp accepts only calendar-valid RFC3339 instants with explicit offsets', () => {
  assert.equal(timestamp(123), null);
  assert.equal(timestamp('2026-07-02'), null);
  assert.equal(timestamp('2026-07-02T00:00:00'), null);
  assert.equal(timestamp('2026-02-30T00:00:00Z'), null);
  assert.equal(timestamp('2026-07-02T09:00:00+09:00'), Date.parse('2026-07-02T00:00:00Z'));
  assert.equal(timestamp('2026-07-02T00:00:00.123Z'), Date.parse('2026-07-02T00:00:00.123Z'));
});

test('validateSnapshot rejects duplicate identifiers and non-monotonic rate timelines', () => {
  const invalid = (mutate) => {
    const value = snapshot();
    mutate(value);
    assert.equal(validateSnapshot(value), null);
  };
  invalid((value) => { value.exact_lookups.push(structuredClone(value.exact_lookups[0])); });
  invalid((value) => {
    value.exact_lookups[0].list_rates[1].effective_from = '2026-06-30T00:00:00Z';
  });
  invalid((value) => {
    value.exact_lookups[0].list_rates[0].effective_to = '2026-07-02T00:00:00Z';
  });
  invalid((value) => {
    value.exact_lookups[0].list_rates[0].effective_to = null;
  });
});

test('validateSnapshot does not pollute Object.prototype for __proto__ model ids', () => {
  const value = snapshot();
  value.exact_lookups[0].external_model_id = '__proto__';
  assert.deepEqual(validateSnapshot(value), value);
  assert.equal(Object.prototype.polluted, undefined);
});

test('rateFor uses exact IDs, timestamp boundaries, open segments, and unpriced failures', () => {
  const value = snapshot(19);
  const before = rateFor(value, 'claude-test', Date.parse('2026-06-30T23:59:59.999Z'));
  const atBoundary = rateFor(value, 'claude-test', Date.parse('2026-07-01T00:00:00Z'));
  assert.deepEqual(before, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, revision: 19 });
  assert.deepEqual(atBoundary, { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.4, revision: 19 });
  assert.deepEqual(rateFor(value, 'claude-test[1m]', Date.parse('2027-01-01T00:00:00Z')), atBoundary);
  value.exact_lookups.push({ external_model_id: 'unpriced', list_rates: [{ effective_from: '2026-01-01T00:00:00Z', effective_to: null, unpriced_reason: 'ambiguous' }] });
  assert.equal(rateFor(value, 'unpriced', Date.now()), null);
  assert.equal(rateFor(value, 'CLAUDE-test', Date.now()), null);
  assert.equal(rateFor(value, 'claude-test', undefined), null);
  assert.equal(rateFor(value, 'missing', Date.now()), null);
  assert.equal(rateFor(value, '[1m]', Date.now()), null);
});

test('refreshCatalog atomically publishes only valid authorized 200 snapshots and preserves known good cache', async () => {
  const dir = temp();
  let mode = 'valid';
  const api = await server((request, response) => {
    assert.equal(request.headers['x-api-key'], 'prism_test');
    if (mode === 'timeout') return;
    if (mode === 'unavailable') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'unavailable' }));
      return;
    }
    if (mode === 'unauthorized') {
      response.writeHead(401);
      response.end('no');
      return;
    }
    if (mode === 'oversized') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('x'.repeat(5 * 1024 * 1024 + 1));
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(mode === 'valid' ? snapshot(9) : mode === 'stale' ? snapshot(8) : { invalid: true }));
  });
  try {
    assert.equal(await refreshCatalog({ ingestUrl: api.url, apiKey: 'prism_test', dataDir: dir, timeoutMs: 100 }), 'ok revision 9');
    const target = cachePathFor(dir, api.url, 9);
    assert.deepEqual(loadCatalog(dir, api.url), snapshot(9));
    for (const next of ['invalid', 'unavailable', 'timeout', 'unauthorized', 'oversized']) {
      mode = next;
      const result = await refreshCatalog({
        ingestUrl: api.url, apiKey: 'prism_test', dataDir: dir, timeoutMs: 30,
      });
      if (next === 'oversized') assert.equal(result, 'kept-cache oversized-response');
      else assert.match(result, /^kept-cache /);
      assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(snapshot(9)));
    }
    mode = 'stale';
    assert.equal(await refreshCatalog({ ingestUrl: api.url, apiKey: 'prism_test', dataDir: dir, timeoutMs: 100 }), 'kept-cache stale-revision');
    assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(snapshot(9)));
  } finally {
    await api.close();
  }
});

test('revision-addressed publishing cannot regress a newer catalog', async () => {
  const dir = temp();
  let revision = 12;
  const api = await server((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(snapshot(revision)));
  });
  try {
    assert.equal(await refreshCatalog({ ingestUrl: api.url, apiKey: 'prism_test', dataDir: dir, timeoutMs: 100 }), 'ok revision 12');
    revision = 11;
    assert.equal(await refreshCatalog({ ingestUrl: api.url, apiKey: 'prism_test', dataDir: dir, timeoutMs: 100 }), 'kept-cache stale-revision');
    assert.equal(loadCatalog(dir, api.url).catalog_revision, 12);

    fs.writeFileSync(cachePathFor(dir, api.url, 11), JSON.stringify(snapshot(11)));
    assert.equal(loadCatalog(dir, api.url).catalog_revision, 12);
  } finally {
    await api.close();
  }
});

test('loadCatalog chooses the highest valid matching revision and ignores corrupt candidates', () => {
  const dir = temp();
  const url = 'http://offline.example';
  writeKnownGood(dir, url, 42);
  fs.writeFileSync(cachePathFor(dir, url, 999), '{truncated');
  fs.writeFileSync(cachePathFor(dir, url, 998), JSON.stringify(snapshot(997)));
  assert.deepEqual(loadCatalog(dir, url), snapshot(42));
});

test('multi-process publishers retain the maximum offered revision without temporary debris', async () => {
  const dir = temp();
  const revisions = new Map([
    ['prism_storm_1', 41],
    ['prism_storm_2', 42],
    ['prism_storm_3', 43],
    ['prism_storm_4', 44],
    ['prism_storm_5', 45],
    ['prism_storm_6', 46],
  ]);
  const pendingResponses = [];
  const api = await server((request, response) => {
    pendingResponses.push({ response, revision: revisions.get(request.headers['x-api-key']) });
    if (pendingResponses.length !== revisions.size) return;
    for (const [index, pending] of pendingResponses
      .sort((left, right) => left.revision - right.revision)
      .entries()) {
      setTimeout(() => {
        pending.response.writeHead(200, { 'content-type': 'application/json' });
        pending.response.end(JSON.stringify(snapshot(pending.revision)));
      }, index * 200);
    }
  });
  try {
    const results = await Promise.all([...revisions.keys()].map((apiKey) => childRefresh({
      ingestUrl: api.url,
      apiKey,
      dataDir: dir,
      timeoutMs: 10_000,
    })));
    assert.deepEqual(results, [...revisions.values()].map((revision) => `ok revision ${revision}`));
    const offeredMaximum = Math.max(...revisions.values());
    assert.equal(loadCatalog(dir, api.url).catalog_revision, offeredMaximum);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
    // Superseded revisions survive a reader grace period before garbage
    // collection; the maximum must be present and selected, lower revisions
    // may linger until they age out.
    const published = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(published.includes(path.basename(cachePathFor(dir, api.url, offeredMaximum))));
  } finally {
    await api.close();
  }
});

test('SIGKILL before rename never exposes a partial revision and a later refresh succeeds', async () => {
  const dir = temp();
  let mode = 'trickle';
  const api = await server((request, response) => {
    const body = JSON.stringify(snapshot(61));
    response.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'trickle') {
      response.write(body.slice(0, 16));
      setTimeout(() => response.end(body.slice(16)), 10);
      return;
    }
    response.end(body);
  });
  try {
    const child = spawn(process.execPath, ['-e', [
      'const fs = require("node:fs");',
      'const originalRenameSync = fs.renameSync;',
      'fs.renameSync = (...args) => {',
      '  process.stdout.write("renaming\\n");',
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 1000);',
      '  return originalRenameSync(...args);',
      '};',
      'const { refreshCatalog } = require(process.env.MODEL_CATALOG_MODULE);',
      'refreshCatalog(JSON.parse(process.env.MODEL_CATALOG_OPTIONS));',
    ].join('\n')], {
      env: {
        ...process.env,
        MODEL_CATALOG_MODULE: path.resolve(__dirname, '../lib/model-catalog'),
        MODEL_CATALOG_OPTIONS: JSON.stringify({
          ingestUrl: api.url,
          apiKey: 'prism_test',
          dataDir: dir,
          timeoutMs: 10 * 1000,
        }),
      },
    });
    const childExit = waitForChildExit(child);
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill('SIGKILL');
    const exit = await childExit;
    assert.equal(exit.signal, 'SIGKILL');
    assert.equal(fs.existsSync(cachePathFor(dir, api.url, 61)), false);
    assert.equal(loadCatalog(dir, api.url), null);
    mode = 'valid';
    assert.equal(
      await refreshCatalog({ ingestUrl: api.url, apiKey: 'prism_test', dataDir: dir, timeoutMs: 100 }),
      'ok revision 61',
    );
    assert.deepEqual(loadCatalog(dir, api.url), snapshot(61));
  } finally {
    await api.close();
  }
});

test('cache files bind to the ingest environment and old single-file caches are ignored then removed', async () => {
  const dir = temp();
  const api = await server((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(snapshot(71)));
  });
  try {
    const oldCache = cachePathFor(dir, api.url, 71).replace(/\.rev71\.json$/, '.json');
    const staleTemp = `${cachePathFor(dir, api.url, 70)}.orphan.tmp`;
    fs.writeFileSync(oldCache, JSON.stringify(snapshot(70)));
    fs.writeFileSync(staleTemp, '{partial');
    const staleAt = new Date(Date.now() - 61 * 1000);
    fs.utimesSync(staleTemp, staleAt, staleAt);
    assert.equal(loadCatalog(dir, api.url), null);
    assert.equal(await refreshCatalog({ ingestUrl: api.url, apiKey: 'prism_test', dataDir: dir, timeoutMs: 100 }), 'ok revision 71');
    assert.equal(fs.existsSync(oldCache), false);
    assert.equal(fs.existsSync(staleTemp), false);
    assert.equal(path.basename(cachePathFor(dir, api.url, 71)), `model-catalog-v${CATALOG_SCHEMA_VERSION}-${crypto.createHash('sha256').update(api.url).digest('hex').slice(0, 16)}.rev71.json`);
    const otherUrl = `${api.url}/other`;
    assert.notEqual(cachePathFor(dir, api.url, 71), cachePathFor(dir, otherUrl, 71));
    assert.equal(loadCatalog(dir, otherUrl), null);
  } finally {
    await api.close();
  }
});

test('loadCatalog is offline and retains a last-known-good snapshot', () => {
  const dir = temp();
  const url = 'http://offline.example';
  const known = writeKnownGood(dir, url, 31);
  assert.deepEqual(loadCatalog(dir, url), known);
  fs.writeFileSync(cachePathFor(dir, url, 31), '{invalid');
  assert.equal(loadCatalog(dir, url), null);
});

test('loadCatalog restarts its scan when concurrent cleanup removes listed revisions', () => {
  const dir = temp();
  const url = 'https://ingest.example.com';
  writeKnownGood(dir, url, 10);

  // Simulate a publisher interleaving between the reader's directory listing
  // and its file reads: the first read of rev10 observes the publisher
  // renaming rev11 in and cleaning rev10 out (ENOENT). The retry must find
  // rev11 instead of returning null.
  const realReadFileSync = fs.readFileSync;
  const rev10Path = cachePathFor(dir, url, 10);
  let interleaved = false;
  fs.readFileSync = (target, ...rest) => {
    if (!interleaved && target === rev10Path) {
      interleaved = true;
      realReadFileSync.call(fs, target, ...rest); // prove it existed at listing time
      fs.writeFileSync(cachePathFor(dir, url, 11), JSON.stringify(snapshot(11)));
      fs.unlinkSync(rev10Path);
      const error = new Error('ENOENT: simulated concurrent cleanup');
      error.code = 'ENOENT';
      throw error;
    }
    return realReadFileSync.call(fs, target, ...rest);
  };
  try {
    const selected = loadCatalog(dir, url);
    assert.ok(selected, 'reader must not observe null while a valid snapshot exists');
    assert.equal(selected.catalog_revision, 11);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
});

test('loadCatalog survives three consecutive cleanup interleaves', () => {
  const dir = temp();
  const url = 'https://ingest.example.com';
  writeKnownGood(dir, url, 20);

  // Grace-period GC makes a vanished candidate practically impossible, but
  // the retry loop must still tolerate repeated publisher interleaves: each
  // of the first three scans loses its highest candidate to a concurrent
  // publisher advancing the revision; the fourth scan is stable.
  const realReadFileSync = fs.readFileSync;
  let interleaves = 0;
  fs.readFileSync = (target, ...rest) => {
    const match = /\.rev(\d+)\.json$/.exec(String(target));
    if (match && interleaves < 3 && Number(match[1]) === 20 + interleaves) {
      interleaves += 1;
      const next = 20 + interleaves;
      fs.writeFileSync(cachePathFor(dir, url, next), JSON.stringify(snapshot(next)));
      fs.unlinkSync(target);
      const error = new Error('ENOENT: simulated concurrent cleanup');
      error.code = 'ENOENT';
      throw error;
    }
    return realReadFileSync.call(fs, target, ...rest);
  };
  try {
    const selected = loadCatalog(dir, url);
    assert.ok(selected, 'reader must not observe null while a valid snapshot exists');
    assert.equal(selected.catalog_revision, 23);
    assert.equal(interleaves, 3);
  } finally {
    fs.readFileSync = realReadFileSync;
  }
});

test('superseded revisions are garbage collected only after the reader grace period', async () => {
  const dir = temp();
  const api = await server((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(snapshot(31)));
  });
  try {
    writeKnownGood(dir, api.url, 30);
    assert.equal(await refreshCatalog({
      ingestUrl: api.url, apiKey: 'k', dataDir: dir, timeoutMs: 2_000,
    }), 'ok revision 31');
    // Fresh superseded revision survives the publish that outranked it.
    assert.ok(fs.existsSync(cachePathFor(dir, api.url, 30)));

    // Age it beyond the grace period; the next publish garbage collects it.
    const aged = new Date(Date.now() - 120_000);
    fs.utimesSync(cachePathFor(dir, api.url, 30), aged, aged);
    fs.unlinkSync(cachePathFor(dir, api.url, 31));
    assert.equal(await refreshCatalog({
      ingestUrl: api.url, apiKey: 'k', dataDir: dir, timeoutMs: 2_000,
    }), 'ok revision 31');
    assert.equal(fs.existsSync(cachePathFor(dir, api.url, 30)), false);
    assert.equal(loadCatalog(dir, api.url).catalog_revision, 31);
  } finally {
    await api.close();
  }
});
