const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { afterEach, test } = require('node:test');

const session = require('../lib/session');
const tempDirs = [];
const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-session-test-'));
  tempDirs.push(dir);
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}

function sessionDir(dataDir, sessionId) {
  const hash = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(dataDir, 'runtime', 'sessions', hash);
}
function generationFiles(dir, name) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => new RegExp(`^${name}\\.g\\d+\\.f\\d+\\.json$`).test(file))
    .sort((left, right) => {
      const leftParts = left.match(/\.g(\d+)\.f(\d+)\.json$/);
      const rightParts = right.match(/\.g(\d+)\.f(\d+)\.json$/);
      return Number(leftParts[2]) - Number(rightParts[2]) || Number(leftParts[1]) - Number(rightParts[1]);
    });
}

function active(epoch, clientEventId = 'client-event') {
  return {
    epoch,
    clientEventId,
    submittedAt: new Date().toISOString(),
    transcriptBoundary: { byteOffset: 10, lineOffset: 2 },
    frozenPayloadHash: crypto.createHash('sha256').update(clientEventId).digest('hex'),
    status: 'submitting',
  };
}
async function advanceInChild(dataDir, sessionId) {
  const modulePath = require.resolve('../lib/session');
  const program = `const s = require(${JSON.stringify(modulePath)}); process.stdout.write(JSON.stringify(s.advanceBarrier(process.argv[1], 'control')));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program, sessionId], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}`));
      else resolve(JSON.parse(output));
    });
  });
}


afterEach(() => {
  session._internals.setTestHook('afterReadRecordEntries', null);
  session._internals.setTestHook('beforeReleaseUnlink', null);
  session._internals.setTestHook('beforeRecordPublish', null);
  if (originalDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('control, failure, and lifecycle barriers invalidate active submissions', () => {
  makeDataDir();
  const sessionId = 'barrier-session';
  const normal = session.advanceBarrier(sessionId, 'normal-pending');
  assert.equal(normal.epoch, 1);
  assert.equal(session.attachActive(sessionId, active(normal.epoch)).active.status, 'submitting');

  const control = session.advanceBarrier(sessionId, 'control');
  assert.equal(control.epoch, 2);
  assert.equal(control.kind, 'control');
  assert.equal(control.active.status, 'invalidated');

  const pending = session.advanceBarrier(sessionId, 'normal-pending');
  session.attachActive(sessionId, active(pending.epoch, 'failed-client'));
  const failed = session.failBarrier(sessionId, pending.epoch);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.active, null);

  const lifecyclePending = session.advanceBarrier(sessionId, 'normal-pending');
  session.attachActive(sessionId, active(lifecyclePending.epoch, 'lifecycle-client'));
  const lifecycle = session.advanceBarrier(sessionId, 'lifecycle');
  assert.equal(lifecycle.kind, 'lifecycle');
  assert.equal(lifecycle.active.status, 'invalidated');
});
test('promotion persists a non-nil server UUID and consumption requires both identities', () => {
  makeDataDir();
  const sessionId = 'server-prompt-id';
  const hostPromptId = 'host-prompt-id';
  const barrier = session.advanceBarrier(sessionId, 'normal-pending');
  assert.ok(session.attachActive(sessionId, {
    ...active(barrier.epoch, 'client-event'),
    submitPromptId: hostPromptId,
  }));

  assert.equal(session.promoteActive(
    sessionId,
    'client-event',
    hostPromptId,
    '00000000-0000-0000-0000-000000000000',
  ), null);
  assert.equal(session.readTurn(sessionId).active.status, 'submitting');

  const serverPromptId = '22222222-2222-4222-8222-222222222222';
  const captured = session.promoteActive(sessionId, 'client-event', hostPromptId, serverPromptId);
  assert.equal(captured.active.serverPromptId, serverPromptId);
  assert.equal(session.consumeActive(sessionId, {
    epoch: captured.epoch,
    clientEventId: 'client-event',
    submitPromptId: hostPromptId,
    serverPromptId: '33333333-3333-4333-8333-333333333333',
  }), null);
  assert.ok(session.consumeActive(sessionId, {
    epoch: captured.epoch,
    clientEventId: 'client-event',
    submitPromptId: hostPromptId,
    serverPromptId,
  }));
});

test('epochs advance monotonically and compact generations are serialized', () => {
  makeDataDir();
  const sessionId = 'monotonic-session';
  const first = session.advanceBarrier(sessionId, 'normal-pending');
  const second = session.advanceBarrier(sessionId, 'control');
  assert.equal(first.epoch, 1);
  assert.equal(second.epoch, 2);
  assert.equal(session.readTurn(sessionId).epoch, 2);

  const compactOne = session.advanceCompactGeneration(sessionId);
  const compactTwo = session.advanceCompactGeneration(sessionId);
  assert.equal(compactOne.generation, 1);
  assert.equal(compactTwo.generation, 2);
});
test('compact barrier reconciles a failed compact publish before readers expose context health', () => {
  const dataDir = makeDataDir();
  const sessionId = 'compact-publish-recovery';
  assert.ok(session.updateSummary(sessionId, (current) => ({
    ...current,
    contextHealth: {
      ...current.contextHealth,
      turnCount: 5,
    },
  })));

  let injected = false;
  session._internals.setTestHook('beforeRecordPublish', ({ name }) => {
    if (name !== 'compact') return;
    injected = true;
    session._internals.setTestHook('beforeRecordPublish', null);
    throw new Error('injected compact publish failure');
  });

  assert.equal(session.advanceCompactBarrier(sessionId), null);
  assert.equal(injected, true);
  const dir = sessionDir(dataDir, sessionId);
  assert.equal(generationFiles(dir, 'turn').length, 1);
  assert.equal(generationFiles(dir, 'compact').length, 0);

  const summary = session.readSummary(sessionId);
  const turn = session.readTurn(sessionId);
  assert.equal(turn.epoch, 1);
  assert.equal(summary.compactGeneration, 1);
  assert.equal(summary.contextHealth.turnCount, 0);
  assert.equal(session.advanceCompactGeneration(sessionId).generation, 2);
});
test('concurrent barrier attempts serialize through the session lock', async () => {
  const dataDir = makeDataDir();
  const sessionId = 'concurrent-session';
  const [first, second] = await Promise.all([
    advanceInChild(dataDir, sessionId),
    advanceInChild(dataDir, sessionId),
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual([first.epoch, second.epoch].sort(), [1, 2]);
  assert.equal(session.readTurn(sessionId).epoch, 2);
});

test('session hashes isolate records and prevent cross-session mutation', () => {
  const dataDir = makeDataDir();
  const alpha = session.advanceBarrier('alpha', 'normal-pending');
  const beta = session.advanceBarrier('beta', 'control');
  assert.notEqual(sessionDir(dataDir, 'alpha'), sessionDir(dataDir, 'beta'));
  assert.equal(session.readTurn('alpha').epoch, alpha.epoch);
  assert.equal(session.readTurn('alpha').kind, 'normal-pending');
  assert.equal(session.readTurn('beta').epoch, beta.epoch);
  assert.equal(session.readTurn('beta').kind, 'control');
  assert.deepEqual(generationFiles(sessionDir(dataDir, 'alpha'), 'turn'), ['turn.g1.f1.json']);
  assert.deepEqual(generationFiles(sessionDir(dataDir, 'beta'), 'turn'), ['turn.g1.f1.json']);
});

test('stale session cleanup only removes directories beyond the TTL', () => {
  const dataDir = makeDataDir();
  const oldSession = 'old-session';
  const freshSession = 'fresh-session';
  session.advanceBarrier(oldSession, 'control');
  session.advanceBarrier(freshSession, 'control');
  const oldDir = sessionDir(dataDir, oldSession);
  const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldDir, stale, stale);

  assert.equal(session.cleanupStaleSessions(), 1);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(sessionDir(dataDir, freshSession)), true);
});

test('schema and identity mismatches are ignored and reinitialized', () => {
  const dataDir = makeDataDir();
  const sessionId = 'identity-session';
  const dir = sessionDir(dataDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'turn.json'), JSON.stringify({
    schemaVersion: 999,
    sessionId: 'other-session',
    updatedAt: new Date().toISOString(),
    generation: 10,
    epoch: 99,
    kind: 'control',
    active: null,
  }));

  assert.equal(session.readTurn(sessionId).epoch, 0);
  const reset = session.advanceBarrier(sessionId, 'lifecycle');
  assert.equal(reset.epoch, 1);
  assert.equal(reset.sessionId, sessionId);
  assert.equal(reset.schemaVersion, 1);
});
test('unsafe generation and epoch records are rejected and terminal generations cannot publish', () => {
  const dataDir = makeDataDir();
  const sessionId = 'safe-integer-terminal';
  const dir = sessionDir(dataDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `turn.g${Number.MAX_SAFE_INTEGER + 1}.f1.json`), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    generation: Number.MAX_SAFE_INTEGER + 1,
    epoch: Number.MAX_SAFE_INTEGER + 1,
    kind: 'control',
    active: null,
  }));
  assert.equal(session.readTurn(sessionId).epoch, 0);

  fs.writeFileSync(path.join(dir, `turn.g${Number.MAX_SAFE_INTEGER}.f2.json`), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    generation: Number.MAX_SAFE_INTEGER,
    epoch: Number.MAX_SAFE_INTEGER,
    kind: 'control',
    active: null,
  }));
  assert.equal(session.readTurn(sessionId).generation, Number.MAX_SAFE_INTEGER);
  assert.equal(session.advanceBarrier(sessionId, 'normal-pending'), null);
  assert.equal(session.readTurn(sessionId).generation, Number.MAX_SAFE_INTEGER);
});
test('stale lock reclamation cannot let a suspended owner release the replacement lock', async () => {
  const dataDir = makeDataDir();
  const sessionId = 'three-writer-lock';
  const modulePath = require.resolve('../lib/session');
  const program = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const session = require(${JSON.stringify(modulePath)});
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    const sessionId = process.argv[1];
    const hash = require('node:crypto').createHash('sha256').update(sessionId).digest('hex');
    const lockDir = path.join(dataDir, 'runtime', 'sessions', hash) + '.lock';
    const ready = path.join(dataDir, 'replacement-ready');
    const done = path.join(dataDir, 'replacement-done');
    const worker = ${JSON.stringify(`
      const fs = require('node:fs');
      const session = require(${JSON.stringify(modulePath)});
      const lockDir = process.env.PRISM_LOCK_DIR;
      const result = session.withSessionLock(process.argv[1], () => {
        fs.writeFileSync(process.env.PRISM_READY, 'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        return fs.existsSync(lockDir) && fs.existsSync(require('node:path').join(lockDir, 'token'));
      });
      fs.writeFileSync(process.env.PRISM_DONE, String(result));
    `)};
    const first = session.withSessionLock(sessionId, () => {
      const stale = new Date(Date.now() - 31_000);
      fs.utimesSync(lockDir, stale, stale);
      spawn(process.execPath, ['-e', worker, sessionId], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PRISM_LOCK_DIR: lockDir, PRISM_READY: ready, PRISM_DONE: done },
      }).unref();
      while (!fs.existsSync(ready)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      return true;
    });
    while (!fs.existsSync(done)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const third = session.advanceBarrier(sessionId, 'control');
    process.stdout.write(JSON.stringify({ first, replacementHeld: fs.readFileSync(done, 'utf8'), third }));
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', program, sessionId], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}`))));
  });
  const result = JSON.parse(output);
  assert.equal(result.first, true);
  assert.equal(result.replacementHeld, 'true');
  assert.equal(result.third.epoch, 1);
});

test('compact barrier leaves both records untouched when the session lock times out', () => {
  const dataDir = makeDataDir();
  const sessionId = 'compact-lock-timeout';
  const lockDir = `${sessionDir(dataDir, sessionId)}.lock`;
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'token'), 'held-by-writer');

  assert.equal(session.advanceCompactBarrier(sessionId), null);
  assert.equal(generationFiles(sessionDir(dataDir, sessionId), 'turn').length, 0);
  assert.equal(generationFiles(sessionDir(dataDir, sessionId), 'compact').length, 0);
});

test('cleanup ignores lock directories and does not remove a session held by a writer', () => {
  const dataDir = makeDataDir();
  const sessionId = 'cleanup-race';
  const dir = sessionDir(dataDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, stale, stale);
  const lockDir = `${dir}.lock`;
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'token'), 'writer-token');
  fs.mkdirSync(path.join(dataDir, 'runtime', 'sessions', 'not-a-session.lock'));

  assert.equal(session.cleanupStaleSessions(), 0);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'sessions', 'not-a-session.lock')), true);
});
test('generation records retain the two newest valid versions per record type', () => {
  const dataDir = makeDataDir();
  const sessionId = 'generation-pruning';

  for (let index = 0; index < 4; index += 1) {
    assert.ok(session.advanceBarrier(sessionId, 'control'));
  }
  for (let index = 0; index < 3; index += 1) {
    assert.ok(session.advanceCompactGeneration(sessionId));
  }

  const dir = sessionDir(dataDir, sessionId);
  assert.deepEqual(generationFiles(dir, 'turn'), ['turn.g3.f3.json', 'turn.g4.f4.json']);
  assert.deepEqual(generationFiles(dir, 'compact'), ['compact.g2.f6.json', 'compact.g3.f7.json']);
  assert.deepEqual(generationFiles(dir, 'summary'), ['summary.g1.f1.json']);
  assert.equal(session.readTurn(sessionId).generation, 4);
});

test('fence-major ordering rejects a stale owner that resumes before its first read', () => {
  const dataDir = makeDataDir();
  const sessionId = 'fenced-stale-owner';
  const dir = sessionDir(dataDir, sessionId);
  const lockDir = `${dir}.lock`;
  const originalLinkSync = fs.linkSync;
  let takeover = null;
  let intercepted = false;

  fs.linkSync = (source, target) => {
    if (!intercepted && path.basename(target) === 'fence.f1.json') {
      intercepted = true;
      originalLinkSync(source, target);
      const quarantine = `${lockDir}.stale.test`;
      fs.renameSync(lockDir, quarantine);
      takeover = session.advanceBarrier(sessionId, 'control');
      fs.rmSync(quarantine, { recursive: true, force: true });
      return;
    }
    return originalLinkSync(source, target);
  };

  let stale;
  try {
    stale = session.advanceBarrier(sessionId, 'normal-pending');
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.equal(stale.epoch, 2);
  assert.equal(takeover.epoch, 1);
  assert.equal(takeover.kind, 'control');
  assert.deepEqual(session.readTurn(sessionId), takeover);
  assert.deepEqual(generationFiles(dir, 'turn'), ['turn.g2.f1.json', 'turn.g1.f2.json']);
});

test('release TOCTOU deletion is safety-neutral after a successor fence commits', () => {
  const dataDir = makeDataDir();
  const sessionId = 'release-toctou';
  const dir = sessionDir(dataDir, sessionId);
  const lockDir = `${dir}.lock`;
  session.advanceBarrier(sessionId, 'normal-pending');
  let takeoverFence = null;

  session._internals.setTestHook('beforeReleaseUnlink', () => {
    session._internals.setTestHook('beforeReleaseUnlink', null);
    fs.renameSync(lockDir, `${lockDir}.stale.test`);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'token'), 'replacement-token');
    takeoverFence = session._internals.allocateFence(dir);
  });

  assert.equal(session.withSessionLock(sessionId, () => true), true);
  assert.equal(takeoverFence, 3);
  assert.equal(fs.existsSync(lockDir), false);

  const successor = session.advanceBarrier(sessionId, 'control');
  assert.equal(successor.epoch, 2);
  assert.equal(session.readTurn(sessionId).kind, 'control');
  assert.deepEqual(generationFiles(dir, 'turn'), ['turn.g1.f1.json', 'turn.g2.f4.json']);
});

test('read retries after records are pruned between enumeration and open', () => {
  makeDataDir();
  const sessionId = 'reader-prune-race';
  session.advanceBarrier(sessionId, 'normal-pending');
  session.advanceBarrier(sessionId, 'control');
  let injected = false;

  session._internals.setTestHook('afterReadRecordEntries', ({ name }) => {
    if (injected || name !== 'turn') return;
    injected = true;
    session._internals.setTestHook('afterReadRecordEntries', null);
    session.advanceBarrier(sessionId, 'normal-pending');
    session.advanceBarrier(sessionId, 'control');
  });

  const current = session.readTurn(sessionId);
  assert.equal(injected, true);
  assert.equal(current.epoch, 4);
  assert.equal(current.kind, 'control');
  assert.equal(current.generation, 4);
});

test('repeated non-publishing acquisitions keep fence markers bounded and monotonic', () => {
  const dataDir = makeDataDir();
  const sessionId = 'fence-noop-bound';
  session.advanceBarrier(sessionId, 'normal-pending');
  const dir = sessionDir(dataDir, sessionId);

  // Stale/invalid promote attempts acquire a fenced lock but publish nothing.
  for (let i = 0; i < 10; i += 1) {
    assert.equal(session.promoteActive(sessionId, 'missing-event-id', 'server-id', '55555555-5555-4555-8555-555555555555'), null);
  }

  const fences = fs.readdirSync(dir).filter((name) => /^fence\.f\d+\.json$/.test(name));
  assert.ok(fences.length <= 4, `retained ${fences.length} fence markers`);
  const highest = Math.max(...fences.map((name) => Number(name.match(/^fence\.f(\d+)\.json$/)[1])));

  // The next allocation must stay greater than every marker ever allocated.
  const next = session.withSessionLock(sessionId, (_sessionDir, fence) => fence);
  assert.ok(next > highest);
  assert.ok(next >= 12, `expected a monotonic fence, got ${next}`);
});
