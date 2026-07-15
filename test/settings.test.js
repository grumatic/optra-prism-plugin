const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');

const API_KEY = 'gck_1234567890abcdef';
const ENV_KEYS = [
  'HOME',
  'PRISM_INGEST_URL',
  'CLAUDE_PLUGIN_OPTION_apiKey',
];

let homeDir;
let projectDir;
let originalEnv;

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-settings-test-'));
  projectDir = path.join(homeDir, 'project');
  fs.mkdirSync(projectDir);

  originalEnv = new Map(ENV_KEYS.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));

  process.env.HOME = homeDir;
  process.env.CLAUDE_PLUGIN_OPTION_apiKey = API_KEY;
  delete process.env.PRISM_INGEST_URL;
});

afterEach(() => {
  for (const [key, original] of originalEnv) {
    if (original.present) process.env[key] = original.value;
    else delete process.env[key];
  }

  clearModule('../lib/config');
  clearModule('../lib/settings');
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('expected OTEL settings explicitly disable assistant response logging', () => {
  const { buildExpectedOtelEnv, OTEL_KEYS } = require('../lib/settings');
  const { buildOtelHeaders, readPluginVersion } = require('../lib/plugin-version');

  const expected = buildExpectedOtelEnv();

  assert.equal(expected.otelEnv.OTEL_LOG_ASSISTANT_RESPONSES, '0');
  assert.ok(OTEL_KEYS.includes('OTEL_LOG_ASSISTANT_RESPONSES'));
  assert.equal(expected.otelEnv.OTEL_EXPORTER_OTLP_HEADERS, buildOtelHeaders(API_KEY));
  assert.equal(
    expected.otelEnv.OTEL_EXPORTER_OTLP_HEADERS,
    `x-api-key=${API_KEY},x-prism-plugin-version=${readPluginVersion()}`,
  );
});

test('sync and check own assistant response logging without replacing unrelated settings', () => {
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  writeJson(settingsFile, {
    permissions: { allow: ['Bash(npm test)'] },
    env: {
      UNRELATED_SETTING: 'preserved',
      OTEL_LOG_ASSISTANT_RESPONSES: '1',
    },
  });

  const { checkOtelSettings, syncOtelSettings } = require('../lib/settings');

  assert.equal(syncOtelSettings({ scope: 'project', projectDir }), true);
  assert.deepEqual(checkOtelSettings({ scope: 'project', projectDir }), {
    ok: true,
    mismatches: [],
  });

  const settings = readJson(settingsFile);
  assert.equal(settings.env.OTEL_LOG_ASSISTANT_RESPONSES, '0');
  assert.equal(settings.env.UNRELATED_SETTING, 'preserved');
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] });

  settings.env.OTEL_LOG_ASSISTANT_RESPONSES = '1';
  writeJson(settingsFile, settings);
  assert.deepEqual(checkOtelSettings({ scope: 'project', projectDir }), {
    ok: false,
    mismatches: ['OTEL_LOG_ASSISTANT_RESPONSES'],
  });
});

test('scope repair recognizes assistant response logging as managed OTEL state', () => {
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  writeJson(settingsFile, {
    env: {
      UNRELATED_SETTING: 'preserved',
      OTEL_LOG_ASSISTANT_RESPONSES: '1',
    },
  });
  writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: {
      'prism@optra-prism': [{ scope: 'user' }],
    },
  });

  const {
    USER_SETTINGS,
    removeOtelSettings,
    resolveOtelScope,
    syncOtelSettings,
  } = require('../lib/settings');

  const resolution = resolveOtelScope(projectDir);
  assert.deepEqual(resolution, {
    action: 'repair',
    targetScope: 'user',
    removeScopes: ['project'],
    warnings: [],
  });

  for (const scope of resolution.removeScopes) {
    removeOtelSettings({ scope, projectDir });
  }
  assert.equal(syncOtelSettings({ scope: resolution.targetScope, projectDir }), true);

  assert.deepEqual(readJson(settingsFile), {
    env: { UNRELATED_SETTING: 'preserved' },
  });
  assert.equal(readJson(USER_SETTINGS).env.OTEL_LOG_ASSISTANT_RESPONSES, '0');
});

test('remove clears assistant response logging and preserves unrelated settings', () => {
  const settingsFile = path.join(projectDir, '.claude', 'settings.local.json');
  writeJson(settingsFile, {
    enabledPlugins: { 'other-plugin@example': true },
    env: {
      UNRELATED_SETTING: 'preserved',
      OTEL_LOG_ASSISTANT_RESPONSES: '0',
    },
  });

  const { removeOtelSettings } = require('../lib/settings');

  assert.deepEqual(removeOtelSettings({ scope: 'project', projectDir }), ['project']);
  assert.deepEqual(readJson(settingsFile), {
    enabledPlugins: { 'other-plugin@example': true },
    env: { UNRELATED_SETTING: 'preserved' },
  });
});
