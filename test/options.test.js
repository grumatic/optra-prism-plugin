const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');
const {
  resolveBooleanOption,
  resolveShowRealtimeSummary,
  resolveStringOption,
} = require('../lib/options');

let homeDir;
let originalEnv;

const ENV_KEYS = [
  'HOME',
  'PRISM_API_KEY',
  'PRISM_GCK_KEY',
  'PRISM_THRESHOLD',
  'CLAUDE_PLUGIN_OPTION_APIKEY',
  'CLAUDE_PLUGIN_OPTION_apiKey',
  'CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD',
  'CLAUDE_PLUGIN_OPTION_prismThreshold',
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
  for (const key of ENV_KEYS) {
    if (key !== 'HOME') delete process.env[key];
  }
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
  assert.deepEqual(resolveShowRealtimeSummary(), { value: false, source: 'default' });
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
test('resolves string options by official env, compatibility env, legacy config, then default', () => {
  const option = {
    officialEnv: 'OFFICIAL',
    compatEnv: 'COMPAT',
    legacyKey: 'value',
    defaultValue: 'default',
    legacyConfig: { value: 'legacy' },
  };

  assert.deepEqual(resolveStringOption({ ...option, env: { OFFICIAL: 'official', COMPAT: 'compat' } }), {
    value: 'official',
    source: 'env-official',
  });
  assert.deepEqual(resolveStringOption({ ...option, env: { COMPAT: 'compat' } }), {
    value: 'compat',
    source: 'env-compat',
  });
  assert.deepEqual(resolveStringOption({ ...option, env: {} }), {
    value: 'legacy',
    source: 'legacy',
  });
  assert.deepEqual(resolveStringOption({ ...option, env: {}, legacyConfig: {} }), {
    value: 'default',
    source: 'default',
  });
});

test('env recognizes official uppercase API key and threshold userConfig values', () => {
  writeLegacyConfig({ apiKey: 'prism_legacy', prismThreshold: 3 });
  process.env.CLAUDE_PLUGIN_OPTION_APIKEY = 'prism_official';
  process.env.CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD = '7.25';
  delete require.cache[require.resolve('../lib/env')];

  const official = require('../lib/env');
  assert.equal(official.API_KEY, 'prism_official');
  assert.equal(official.PRISM_THRESHOLD, 7.25);

  process.env.PRISM_API_KEY = 'prism_explicit';
  process.env.PRISM_THRESHOLD = '9.5';
  delete require.cache[require.resolve('../lib/env')];

  const explicit = require('../lib/env');
  assert.equal(explicit.API_KEY, 'prism_explicit');
  assert.equal(explicit.PRISM_THRESHOLD, 9.5);
  delete require.cache[require.resolve('../lib/env')];
});
test('env exports the resolved realtime summary value', () => {
  process.env.CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY = 'false';
  delete require.cache[require.resolve('../lib/env')];

  assert.equal(require('../lib/env').SHOW_REALTIME_SUMMARY, false);

  delete require.cache[require.resolve('../lib/env')];
});
