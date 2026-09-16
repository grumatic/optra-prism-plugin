const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-host-observation-state-'));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  delete require.cache[require.resolve('../lib/host-observation-state')];
});

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a kind is unsupported only after it is marked, and only for its own session', () => {
  const state = require('../lib/host-observation-state');
  assert.equal(state.isKindUnsupported('session-a', 'stop_context'), false);
  assert.equal(state.markKindUnsupported('session-a', 'stop_context'), true);
  assert.equal(state.isKindUnsupported('session-a', 'stop_context'), true);
  assert.equal(state.isKindUnsupported('session-a', 'session_end'), false);
  assert.equal(state.isKindUnsupported('session-b', 'stop_context'), false);
});

test('marking a kind unsupported twice is idempotent', () => {
  const state = require('../lib/host-observation-state');
  assert.equal(state.markKindUnsupported('session-a', 'queued_input'), true);
  assert.equal(state.markKindUnsupported('session-a', 'queued_input'), true);
  assert.equal(state.isKindUnsupported('session-a', 'queued_input'), true);
});

test('hook source recorded for a host_prompt_id is readable, including an explicit null', () => {
  const state = require('../lib/host-observation-state');
  assert.equal(state.readHookSource('session-a', 'prompt-1'), null);
  assert.equal(state.recordHookSource('session-a', 'prompt-1', 'user'), true);
  assert.equal(state.readHookSource('session-a', 'prompt-1'), 'user');
  assert.equal(state.recordHookSource('session-a', 'prompt-2', null), true);
  assert.equal(state.readHookSource('session-a', 'prompt-2'), null);
  assert.equal(state.readHookSource('session-b', 'prompt-1'), null);
});

test('stop ordinal allocation is 0-based, increasing, and independent per host_prompt_id', () => {
  const state = require('../lib/host-observation-state');
  assert.equal(state.nextStopOrdinal('session-a', 'prompt-1'), 0);
  assert.equal(state.nextStopOrdinal('session-a', 'prompt-1'), 1);
  assert.equal(state.nextStopOrdinal('session-a', 'prompt-1'), 2);
  assert.equal(state.nextStopOrdinal('session-a', 'prompt-2'), 0);
});

test('tracked host_prompt_id maps are bounded and evict the oldest entry', () => {
  const state = require('../lib/host-observation-state');
  for (let index = 0; index < state.MAX_TRACKED_PROMPT_IDS + 5; index += 1) {
    state.recordHookSource('session-a', `prompt-${index}`, 'user');
  }
  assert.equal(state.readHookSource('session-a', 'prompt-0'), null);
  assert.equal(state.readHookSource('session-a', `prompt-${state.MAX_TRACKED_PROMPT_IDS + 4}`), 'user');
});

test('an unreadable or missing session id is a safe no-op, never a throw', () => {
  const state = require('../lib/host-observation-state');
  assert.equal(state.isKindUnsupported('', 'stop_context'), false);
  assert.equal(state.isKindUnsupported(undefined, 'stop_context'), false);
  assert.equal(state.markKindUnsupported('', 'stop_context'), false);
  assert.equal(state.readHookSource('', 'prompt-1'), null);
  assert.equal(state.recordHookSource('session-a', '', 'user'), false);
  assert.equal(state.nextStopOrdinal('', 'prompt-1'), 0);
});
