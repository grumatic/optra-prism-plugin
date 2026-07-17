const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');
const {
  resolveBooleanOption,
  resolveShowRealtimeSummary,
} = require('../lib/options');

let homeDir;
let originalEnv;

const ENV_KEYS = [
  'HOME',
  'CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY',
  'CLAUDE_PLUGIN_OPTION_showRealtimeSummary',
  'CLAUDE_PLUGIN_OPTION_showStatusLine',
];

function writeLegacyConfig(value) {
  const configPath = path.join(homeDir, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-options-test-'));
  originalEnv = new Map(ENV_KEYS.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
  process.env.HOME = homeDir;
  delete process.env.CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY;
  delete process.env.CLAUDE_PLUGIN_OPTION_showRealtimeSummary;
});

afterEach(() => {
  for (const [key, original] of originalEnv) {
    if (original.present) process.env[key] = original.value;
    else delete process.env[key];
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('resolves showRealtimeSummary by official env, compatibility env, legacy config, then default', () => {
  writeLegacyConfig({ showRealtimeSummary: true });
  process.env.CLAUDE_PLUGIN_OPTION_showRealtimeSummary = 'false';
  process.env.CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY = 'true';
  assert.deepEqual(resolveShowRealtimeSummary(), { value: true, source: 'env-official' });

  delete process.env.CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY;
  assert.deepEqual(resolveShowRealtimeSummary(), { value: false, source: 'env-compat' });

  delete process.env.CLAUDE_PLUGIN_OPTION_showRealtimeSummary;
  assert.deepEqual(resolveShowRealtimeSummary(), { value: true, source: 'legacy' });

  fs.rmSync(path.join(homeDir, '.prism', 'config.json'));
  assert.deepEqual(resolveShowRealtimeSummary(), { value: true, source: 'default' });
});

test('accepts booleans and exact lowercase boolean strings, including false', () => {
  const option = {
    officialEnv: 'OFFICIAL',
    compatEnv: 'COMPAT',
    legacyKey: 'enabled',
    defaultValue: true,
  };

  assert.deepEqual(resolveBooleanOption({
    ...option,
    env: { OFFICIAL: false },
  }), { value: false, source: 'env-official' });
  assert.deepEqual(resolveBooleanOption({
    ...option,
    env: { OFFICIAL: true },
  }), { value: true, source: 'env-official' });
  assert.deepEqual(resolveBooleanOption({
    ...option,
    env: { OFFICIAL: 'true' },
  }), { value: true, source: 'env-official' });
  assert.deepEqual(resolveBooleanOption({
    ...option,
    env: { COMPAT: 'false' },
  }), { value: false, source: 'env-compat' });
  assert.deepEqual(resolveBooleanOption({
    ...option,
    env: {},
    legacyConfig: { enabled: false },
  }), { value: false, source: 'legacy' });
});

test('returns the safe default and error for invalid higher-priority values without falling through', () => {
  const option = {
    officialEnv: 'OFFICIAL',
    compatEnv: 'COMPAT',
    legacyKey: 'enabled',
    defaultValue: true,
    legacyConfig: { enabled: false },
  };

  for (const [env, source] of [
    [{ OFFICIAL: 1 }, 'env-official'],
    [{ OFFICIAL: '' }, 'env-official'],
    [{ OFFICIAL: 'True' }, 'env-official'],
    [{ COMPAT: 'yes' }, 'env-compat'],
  ]) {
    const result = resolveBooleanOption({ ...option, env });
    assert.equal(result.value, true);
    assert.equal(result.source, source);
    assert.match(result.error, /Invalid boolean value/);
  }

  const legacy = resolveBooleanOption({
    ...option,
    env: {},
    legacyConfig: { enabled: 0 },
  });
  assert.equal(legacy.value, true);
  assert.equal(legacy.source, 'legacy');
  assert.match(legacy.error, /Invalid boolean value/);
});

test('a legacy value remains masked by either environment source', () => {
  writeLegacyConfig({ showRealtimeSummary: false });
  process.env.CLAUDE_PLUGIN_OPTION_showRealtimeSummary = 'true';
  assert.deepEqual(resolveShowRealtimeSummary(), { value: true, source: 'env-compat' });

  process.env.CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY = 'false';
  assert.deepEqual(resolveShowRealtimeSummary(), { value: false, source: 'env-official' });
});
test('env exports the resolved realtime summary value', () => {
  process.env.CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY = 'false';
  delete require.cache[require.resolve('../lib/env')];

  assert.equal(require('../lib/env').SHOW_REALTIME_SUMMARY, false);

  delete require.cache[require.resolve('../lib/env')];
});
test('deprecated showStatusLine does not affect the runtime compatibility export', () => {
  writeLegacyConfig({ showStatusLine: false });
  process.env.CLAUDE_PLUGIN_OPTION_showStatusLine = 'false';
  delete require.cache[require.resolve('../lib/env')];

  assert.equal(require('../lib/env').SHOW_STATUS_LINE, true);

  delete require.cache[require.resolve('../lib/env')];
});
