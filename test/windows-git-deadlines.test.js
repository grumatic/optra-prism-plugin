'use strict';

require('./helpers/isolate-claude-env');

// The bounds are fixed when the modules load, so each case reloads them
// under a stubbed process.platform.

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const MODULE_PATHS = ['../lib/git', '../hooks/scripts/stop-handler'];
const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

function clearModules() {
  for (const modulePath of MODULE_PATHS) delete require.cache[require.resolve(modulePath)];
}

function loadOn(platform) {
  Object.defineProperty(process, 'platform', { ...PLATFORM, value: platform });
  clearModules();
  return { git: require('../lib/git'), stop: require('../hooks/scripts/stop-handler') };
}

afterEach(() => {
  Object.defineProperty(process, 'platform', PLATFORM);
  clearModules();
});

test('Windows gets a longer bound for the Git commands a hook runs before publishing', () => {
  const { git, stop } = loadOn('win32');
  assert.equal(git.DEADLINE_MS, 1000);
  assert.equal(stop.LEAVE_RECORD_HEAD_DEADLINE_MS, 1000);
});

test('other platforms keep the 250 ms bound', () => {
  for (const platform of ['darwin', 'linux']) {
    const { git, stop } = loadOn(platform);
    assert.equal(git.DEADLINE_MS, 250, platform);
    assert.equal(stop.LEAVE_RECORD_HEAD_DEADLINE_MS, 250, platform);
  }
});

test('the bounds of hooks that run outside the prompt path are the same on every platform', () => {
  for (const platform of ['win32', 'linux']) {
    const { git } = loadOn(platform);
    assert.equal(git.ROOT_BASELINE_DEADLINE_MS, 1000, platform);
    assert.equal(git.EVIDENCE_COLLECT_DEADLINE_MS, 5000, platform);
  }
});
