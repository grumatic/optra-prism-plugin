'use strict';

require('./helpers/isolate-claude-env');

// The lock constants are fixed when lib/session loads, so each case reloads
// it under a stubbed process.platform. A stubbed fs.mkdirSync stands in for
// Windows answering EPERM while a lock directory is still being deleted.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const SESSION_MODULE = require.resolve('../lib/session');
const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');
const MKDIR = fs.mkdirSync;
const originalDataDir = process.env.CLAUDE_PLUGIN_DATA;
const tempDirs = [];

function loadSessionOn(platform) {
  Object.defineProperty(process, 'platform', { ...PLATFORM, value: platform });
  delete require.cache[SESSION_MODULE];
  const dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-session-lock-')));
  tempDirs.push(dataDir);
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  return require('../lib/session');
}

// Makes creating a session lock directory fail with EPERM `times` times.
function denyLockDirectory(times) {
  let denied = 0;
  fs.mkdirSync = function mkdirSync(target, ...rest) {
    if (String(target).endsWith('.lock') && denied < times) {
      denied += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, mkdir'), { code: 'EPERM' });
    }
    return MKDIR.call(this, target, ...rest);
  };
  return () => denied;
}

afterEach(() => {
  fs.mkdirSync = MKDIR;
  Object.defineProperty(process, 'platform', PLATFORM);
  delete require.cache[SESSION_MODULE];
  if (originalDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalDataDir;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('a session lock is waited for longer on Windows', () => {
  assert.equal(loadSessionOn('win32')._internals.LOCK_TIMEOUT_MS, 1000);
  for (const platform of ['darwin', 'linux']) {
    assert.equal(loadSessionOn(platform)._internals.LOCK_TIMEOUT_MS, 200, platform);
  }
});

test('Windows retries a lock directory that answers EPERM while it is being deleted', () => {
  const session = loadSessionOn('win32');
  const denied = denyLockDirectory(2);

  const record = session.advanceBarrier('pending-delete', 'control');
  assert.ok(record);
  assert.equal(record.epoch, 1);
  assert.equal(denied(), 2);
});

test('Windows gives up on a lock directory that keeps answering EPERM', () => {
  const session = loadSessionOn('win32');
  const denied = denyLockDirectory(Infinity);

  assert.equal(session.advanceBarrier('denied', 'control'), null);
  assert.ok(denied() > 1, 'the lock was retried before giving up');
  // Waiting out the whole lock timeout would take about a hundred attempts.
  assert.ok(denied() < 50, `gave up after ${denied()} attempts`);
});

test('other platforms fail at once when the lock directory answers EPERM', () => {
  const session = loadSessionOn('linux');
  const denied = denyLockDirectory(Infinity);

  assert.equal(session.advanceBarrier('denied', 'control'), null);
  assert.equal(denied(), 1);
});
