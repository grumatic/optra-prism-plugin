'use strict';

require('./helpers/isolate-claude-env');

// Capture keeps evidence flowing into the outbox while delivery waits for a
// refresh: the capture gate, where a refusal came from, the binding each
// queued entry belongs to, and the rate-limited skip log.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const MODULES = [
  '../lib/env',
  '../lib/config',
  '../lib/git-evidence-capability',
  '../lib/git-evidence-outbox',
  '../lib/git-evidence-delivery',
  '../lib/git-evidence-skip-log',
  '../lib/ingest',
];

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function resetModules() {
  for (const name of MODULES) delete require.cache[require.resolve(name)];
}

// Scopes HOME (for ~/.prism/config.json) and CLAUDE_PLUGIN_DATA around
// `action`, with fresh module state on both sides.
async function withEnv(home, dataDir, action) {
  const previousHome = process.env.HOME;
  const previousData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.HOME = home;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  resetModules();
  try {
    return await action();
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previousData;
    resetModules();
  }
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function setup(apiKey = 'prism_capture_gate', ingestUrl = 'http://127.0.0.1:9') {
  const home = tempDir('prism-capture-gate-home-');
  const dataDir = tempDir('prism-capture-gate-data-');
  writeConfig(home, apiKey, ingestUrl);
  return { home, dataDir, apiKey, ingestUrl };
}

function writeSnapshot(dataDir, snapshot) {
  const runtime = path.join(dataDir, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(
    path.join(runtime, `git-evidence-capability-${snapshot.binding_digest}.json`),
    JSON.stringify(snapshot),
  );
}

function snapshotFor(digest, { state = 'supported', ageMs = 0, source, versions = ['git-evidence/v1'], endpoint = '/v1/git-evidence' } = {}) {
  const at = new Date(Date.now() - ageMs).toISOString();
  return {
    schema_version: 'git-evidence-capability-cache/v1',
    binding_digest: digest,
    checked_at: at,
    last_success_at: at,
    state,
    ...(endpoint ? { endpoint } : {}),
    ...(versions ? { versions } : {}),
    ...(source ? { source } : {}),
  };
}

function pendingEntry(eventId, extra = {}) {
  return {
    eventId,
    schemaVersion: 'git-evidence/v1',
    observedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    correlation: { sessionId: 'session-capture-gate', clientEventId: `client-${eventId}` },
    payload: { event_id: eventId, schema_version: 'git-evidence/v1' },
    ...extra,
  };
}

const HOUR = 3600000;
const DAY = 24 * HOUR;

test('capture stays open past delivery\'s one hour, up to the outbox retention after the last success', async () => {
  const env = setup();
  await withEnv(env.home, env.dataDir, async () => {
    const capability = require('../lib/git-evidence-capability');
    const digest = capability.currentBindingDigest();
    const reason = (options) => capability.captureClosedReason(snapshotFor(digest, options));

    assert.equal(reason({}), null);
    assert.equal(reason({ ageMs: 2 * HOUR }), null, 'an hour-old cache still captures');
    assert.equal(capability.capabilityAllowsEvidence(snapshotFor(digest, { ageMs: 2 * HOUR })), false, 'but delivery waits');
    assert.equal(reason({ ageMs: 29 * DAY }), null);
    assert.equal(reason({ ageMs: 31 * DAY }), 'expired');
    assert.equal(capability.captureClosedReason(null), 'missing');
    assert.equal(capability.captureClosedReason(snapshotFor('0'.repeat(32))), 'missing', 'another binding\'s cache never opens capture');
  });
});

test('only a refusal a refresh confirmed closes capture; one from a delivery response pauses delivery only', async () => {
  const env = setup();
  await withEnv(env.home, env.dataDir, async () => {
    const capability = require('../lib/git-evidence-capability');
    const digest = capability.currentBindingDigest();
    const reason = (options) => capability.captureClosedReason(snapshotFor(digest, options));

    assert.equal(reason({ state: 'unsupported', endpoint: null, versions: null }), 'unsupported');
    assert.equal(reason({ state: 'auth_error', source: 'refresh' }), 'auth_error');
    // Without the refresh's mark (a delivery response, or an older plugin)
    // a refusal pauses delivery only.
    assert.equal(reason({ state: 'auth_error' }), null);
    assert.equal(reason({ state: 'withdrawn' }), null);
    assert.equal(capability.capabilityAllowsEvidence(snapshotFor(digest, { state: 'auth_error' })), false);
    assert.equal(reason({ state: 'protocol_error' }), null, 'a binding once confirmed keeps capturing through a protocol error');
    assert.equal(reason({ state: 'protocol_error', endpoint: null, versions: null }), 'protocol_error', 'one never confirmed does not');
  });
});

test('a delivery transition writes no source, and only a refresh\'s auth_error, kept through a transient one, closes capture', async () => {
  let mode = 'down';
  const server = await startServer((req, res) => {
    if (mode === 'down' || mode === 'denied') {
      res.writeHead(mode === 'down' ? 503 : 401);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contracts: { git_evidence: { endpoint: '/v1/git-evidence', versions: ['git-evidence/v1'] } } }));
  });
  const env = setup('prism_capture_gate_source', server.url);
  try {
    await withEnv(env.home, env.dataDir, async () => {
      const capability = require('../lib/git-evidence-capability');
      const digest = capability.currentBindingDigest();
      writeSnapshot(env.dataDir, snapshotFor(digest, { ageMs: 10 * 60000 }));

      assert.equal(capability.markCapabilityWithdrawn(), true);
      let cached = capability.readCapabilityCache();
      assert.equal(cached.state, 'withdrawn');
      // No source key: an older plugin sharing the data directory still
      // reads this cache rather than replacing it.
      assert.ok(!Object.prototype.hasOwnProperty.call(cached, 'source'));
      assert.equal(capability.captureClosedReason(cached), null);
      assert.equal(capability.markCapabilityAuthError(), true);
      assert.ok(!Object.prototype.hasOwnProperty.call(capability.readCapabilityCache(), 'source'));
      assert.equal(capability.captureClosedReason(capability.readCapabilityCache()), null);

      cached = await capability.refreshCapability({ force: true });
      assert.equal(cached.state, 'auth_error', 'a transient refresh keeps the state');
      assert.equal(capability.captureClosedReason(capability.readCapabilityCache()), null);

      mode = 'up';
      cached = await capability.refreshCapability({ force: true });
      assert.equal(cached.state, 'supported');
      assert.equal(capability.readCapabilityCache().source, undefined);

      // The config endpoint itself refusing the key closes capture too.
      mode = 'denied';
      cached = await capability.refreshCapability({ force: true });
      assert.equal(cached.state, 'auth_error');
      assert.equal(capability.readCapabilityCache().source, 'refresh');
      assert.equal(capability.captureClosedReason(capability.readCapabilityCache()), 'auth_error');

      mode = 'down';
      await capability.refreshCapability({ force: true });
      assert.equal(capability.readCapabilityCache().source, 'refresh', 'a transient refresh keeps the refresh\'s mark');
      assert.equal(capability.captureClosedReason(capability.readCapabilityCache()), 'auth_error');

      // A drain begun before that refresh gets its own 401 afterwards.
      assert.equal(capability.markCapabilityAuthError(), true);
      assert.equal(capability.readCapabilityCache().source, 'refresh', 'repeating the refusal keeps its mark');
      assert.equal(capability.captureClosedReason(capability.readCapabilityCache()), 'auth_error');
      assert.equal(capability.markCapabilityWithdrawn(), true);
      assert.ok(!Object.prototype.hasOwnProperty.call(capability.readCapabilityCache(), 'source'), 'another state carries none');
    });
  } finally {
    await server.close();
  }
});

test('a cache without the source key still reads, and an unknown source value does not', async () => {
  const env = setup();
  await withEnv(env.home, env.dataDir, async () => {
    const capability = require('../lib/git-evidence-capability');
    const digest = capability.currentBindingDigest();
    writeSnapshot(env.dataDir, snapshotFor(digest));
    assert.equal(capability.readCapabilityCache().state, 'supported');
    writeSnapshot(env.dataDir, { ...snapshotFor(digest), source: 'other' });
    assert.equal(capability.readCapabilityCache(), null);
  });
});

test('a refresh that confirms a refusal leaves pending evidence in the outbox', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contracts: {} }));
  });
  const env = setup('prism_capture_gate_refused', server.url);
  try {
    await withEnv(env.home, env.dataDir, async () => {
      const capability = require('../lib/git-evidence-capability');
      const outbox = require('../lib/git-evidence-outbox');
      const digest = capability.currentBindingDigest();
      const mine = crypto.randomUUID();
      const legacy = crypto.randomUUID();
      assert.equal(outbox.enqueueEvidence(pendingEntry(mine, { bindingDigest: digest })).outcome, 'created');
      assert.equal(outbox.enqueueEvidence(pendingEntry(legacy)).outcome, 'created');

      const snapshot = await capability.refreshCapability({ force: true });
      assert.equal(snapshot.state, 'unsupported');
      assert.deepEqual(outbox.listPendingEvidence().map((entry) => entry.eventId).sort(), [mine, legacy].sort());
    });
  } finally {
    await server.close();
  }
});

test('delivery refreshes when due and sends only entries captured under the current binding', async () => {
  const requests = [];
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      if (req.url === '/v1/plugin/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ contracts: { git_evidence: { endpoint: '/v1/git-evidence', versions: ['git-evidence/v1'] } } }));
        return;
      }
      const eventId = JSON.parse(body).event_id;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ event_id: eventId, schema_version: 'git-evidence/v1', status: 'accepted' }));
    });
  });
  const env = setup('prism_capture_gate_delivery', server.url);
  try {
    await withEnv(env.home, env.dataDir, async () => {
      const capability = require('../lib/git-evidence-capability');
      const outbox = require('../lib/git-evidence-outbox');
      const { drainEvidence } = require('../lib/git-evidence-delivery');
      const digest = capability.currentBindingDigest();
      // An hour-and-a-half old cache: delivery is closed until a refresh.
      writeSnapshot(env.dataDir, snapshotFor(digest, { ageMs: 90 * 60000 }));
      const mine = crypto.randomUUID();
      const legacy = crypto.randomUUID();
      const other = crypto.randomUUID();
      outbox.enqueueEvidence(pendingEntry(mine, { bindingDigest: digest }));
      outbox.enqueueEvidence(pendingEntry(legacy));
      outbox.enqueueEvidence(pendingEntry(other, { bindingDigest: 'e'.repeat(32) }));

      await drainEvidence({ limit: 8, maxElapsedMs: 5000 });
      assert.equal(requests.filter((request) => request.url === '/v1/plugin/config').length, 1, 'refreshed once');
      const sent = requests.filter((request) => request.method === 'POST').map((request) => JSON.parse(request.body).event_id);
      assert.deepEqual(sent.sort(), [mine, legacy].sort());
      assert.deepEqual(outbox.listPendingEvidence().map((entry) => entry.eventId), [other], 'another binding\'s entry waits');
    });
  } finally {
    await server.close();
  }
});

test('each skip reason is logged at most once an hour per session', async () => {
  const env = setup();
  await withEnv(env.home, env.dataDir, async () => {
    const { logEvidenceSkip } = require('../lib/git-evidence-skip-log');
    const sessionDir = (sessionId) => path.join(env.dataDir, 'runtime', 'sessions', crypto.createHash('sha256').update(sessionId).digest('hex'));
    for (const sessionId of ['session-skip-log-a', 'session-skip-log-b']) fs.mkdirSync(sessionDir(sessionId), { recursive: true });
    const now = Date.now();
    assert.equal(logEvidenceSkip('session-skip-log-a', 'capability_unsupported', { now }), true);
    assert.equal(logEvidenceSkip('session-skip-log-a', 'capability_unsupported', { now: now + 10 * 60000 }), false);
    assert.equal(logEvidenceSkip('session-skip-log-a', 'no_repository', { now: now + 10 * 60000 }), true, 'another reason is its own');
    assert.equal(logEvidenceSkip('session-skip-log-b', 'capability_unsupported', { now }), true, 'another session is its own');
    assert.equal(logEvidenceSkip('session-skip-log-a', 'capability_unsupported', { now: now + HOUR + 1 }), true);
    assert.equal(logEvidenceSkip(null, 'delivery_withdrawn', { now }), true);
    assert.equal(logEvidenceSkip(null, 'delivery_withdrawn', { now: now + 1000 }), false);
    assert.equal(logEvidenceSkip('session-skip-log-a', 'Not A Reason', { now }), false);

    const lines = fs.readFileSync(path.join(env.dataDir, 'debug.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    assert.match(lines[0], /^\[git-evidence \S+\] skip reason=capability_unsupported session=session-$/);
    assert.match(lines[4], /skip reason=delivery_withdrawn session=-$/);

    // A session with no directory is logged, and its directory never made:
    // one without a turn record would hold its stale responses back.
    assert.equal(logEvidenceSkip('session-skip-log-gone', 'no_repository', { now }), true);
    assert.equal(fs.existsSync(sessionDir('session-skip-log-gone')), false);
  });
});

test('delivery that stays closed after its refresh logs why: stale, or the state it holds', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(503);
    res.end();
  });
  const env = setup('prism_capture_gate_paused', server.url);
  try {
    await withEnv(env.home, env.dataDir, async () => {
      const capability = require('../lib/git-evidence-capability');
      const outbox = require('../lib/git-evidence-outbox');
      const { drainEvidence } = require('../lib/git-evidence-delivery');
      const digest = capability.currentBindingDigest();
      const reasons = () => fs.readFileSync(path.join(env.dataDir, 'debug.log'), 'utf8')
        .split('\n').map((line) => (line.match(/skip reason=(\S+)/) || [])[1]).filter(Boolean);
      outbox.enqueueEvidence(pendingEntry(crypto.randomUUID(), { bindingDigest: digest }));

      await drainEvidence({ limit: 8, maxElapsedMs: 5000 });
      writeSnapshot(env.dataDir, snapshotFor(digest, { ageMs: 2 * HOUR }));
      await drainEvidence({ limit: 8, maxElapsedMs: 5000 });
      writeSnapshot(env.dataDir, snapshotFor(digest, { state: 'withdrawn' }));
      await drainEvidence({ limit: 8, maxElapsedMs: 5000 });

      // With no cache yet, a refresh that cannot reach the service records a
      // protocol error rather than leaving the binding without a cache.
      assert.deepEqual(reasons(), ['delivery_protocol_error', 'delivery_stale', 'delivery_withdrawn']);
      assert.equal(outbox.listPendingEvidence().length, 1, 'the entry waits for a later delivery');
    });
  } finally {
    await server.close();
  }
});

// Fills the outbox to its entry cap directly (enqueueing 2048 entries one by
// one rescans the directory each time): `other` entries of another binding,
// oldest first, the rest of `digest`'s.
function fillOutbox(outbox, digest, other) {
  const dir = outbox.getEvidenceOutboxDir();
  fs.mkdirSync(dir, { recursive: true });
  const ids = { other: [], mine: [] };
  for (let index = 0; index < outbox.MAX_EVIDENCE_PENDING_ENTRIES; index += 1) {
    const eventId = crypto.randomUUID();
    const isOther = index < other;
    const createdAt = new Date(Date.now() - (outbox.MAX_EVIDENCE_PENDING_ENTRIES - index) * 1000).toISOString();
    const entry = {
      ...pendingEntry(eventId, { bindingDigest: isOther ? 'f'.repeat(64) : digest }),
      createdAt,
      deliveryAttempts: 0,
      nextAttemptAt: createdAt,
    };
    fs.writeFileSync(outbox.entryFile(eventId), JSON.stringify(entry));
    (isOther ? ids.other : ids.mine).push(eventId);
  }
  return ids;
}

test('a full outbox makes room from entries of another binding, oldest first, never from the current one\'s', async () => {
  const env = setup();
  await withEnv(env.home, env.dataDir, async () => {
    const capability = require('../lib/git-evidence-capability');
    const outbox = require('../lib/git-evidence-outbox');
    const digest = capability.currentBindingDigest();
    const ids = fillOutbox(outbox, digest, 2);

    const incoming = crypto.randomUUID();
    assert.equal(outbox.enqueueEvidence(pendingEntry(incoming, { bindingDigest: digest })).outcome, 'created');
    const pending = new Set(outbox.listPendingEvidence().map((entry) => entry.eventId));
    assert.equal(pending.has(ids.other[0]), false, 'the oldest entry of the other binding made room');
    assert.equal(JSON.parse(fs.readFileSync(outbox.terminalEntryFile(ids.other[0]), 'utf8')).reason, 'local_capacity_full');
    assert.equal(pending.has(ids.other[1]), true, 'only as many as needed');
    assert.ok(ids.mine.every((eventId) => pending.has(eventId)));
  });
});

test('a full outbox of the current binding\'s own entries still turns the new one away', async () => {
  const env = setup();
  await withEnv(env.home, env.dataDir, async () => {
    const capability = require('../lib/git-evidence-capability');
    const outbox = require('../lib/git-evidence-outbox');
    const digest = capability.currentBindingDigest();
    fillOutbox(outbox, digest, 0);
    assert.equal(outbox.enqueueEvidence(pendingEntry(crypto.randomUUID(), { bindingDigest: digest })).outcome, 'capacity_full');
    assert.equal(outbox.listPendingEvidence().length, outbox.MAX_EVIDENCE_PENDING_ENTRIES);
  });
});
