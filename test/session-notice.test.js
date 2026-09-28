const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  NOTICE_TTL_MS,
  claimSessionNotice,
  noticeDirFor,
} = require('../lib/session-notice');

function makeDataDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-session-notice-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a notice key is claimed once per session', (t) => {
  const dataDir = makeDataDir(t);
  const claim = (sessionId, key) => claimSessionNotice({ dataDir, sessionId, key });

  assert.equal(claim('session-a', 'activation-failure@1.2.3'), true);
  assert.equal(claim('session-a', 'activation-failure@1.2.3'), false);
  assert.equal(claim('session-a', 'activation-failure@1.2.4'), true);
  assert.equal(claim('session-b', 'activation-failure@1.2.3'), true);
  assert.equal(fs.statSync(noticeDirFor(dataDir)).mode & 0o777, 0o700);
});

test('claims fail open without a usable data directory or session id', (t) => {
  const dataDir = makeDataDir(t);

  assert.equal(claimSessionNotice({ dataDir: 'relative', sessionId: 's', key: 'k' }), true);
  assert.equal(claimSessionNotice({ dataDir, sessionId: '', key: 'k' }), true);
  assert.equal(claimSessionNotice({ dataDir, sessionId: undefined, key: 'k' }), true);
  assert.equal(claimSessionNotice({ dataDir, sessionId: 's', key: '' }), true);
  assert.equal(fs.existsSync(noticeDirFor(dataDir)), false);
});

test('claims fail open when the notice directory cannot be created', (t) => {
  const dataDir = makeDataDir(t);
  fs.mkdirSync(path.join(dataDir, 'runtime'));
  fs.writeFileSync(noticeDirFor(dataDir), 'not a directory');

  assert.equal(claimSessionNotice({ dataDir, sessionId: 's', key: 'k' }), true);
  assert.equal(claimSessionNotice({ dataDir, sessionId: 's', key: 'k' }), true);
});

test('a new claim prunes expired flags and keeps unrelated files', (t) => {
  const dataDir = makeDataDir(t);
  const now = Date.now();
  assert.equal(claimSessionNotice({ dataDir, sessionId: 'old', key: 'k' }), true);
  const dir = noticeDirFor(dataDir);
  const [oldFlag] = fs.readdirSync(dir);
  const expired = new Date(now - NOTICE_TTL_MS - 1000);
  fs.utimesSync(path.join(dir, oldFlag), expired, expired);
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'preserve');

  assert.equal(claimSessionNotice({ dataDir, sessionId: 'new', key: 'k', now: () => now }), true);

  const remaining = fs.readdirSync(dir).sort();
  assert.equal(remaining.includes(oldFlag), false);
  assert.equal(remaining.includes('unrelated.txt'), true);
  assert.equal(remaining.length, 2);
});
