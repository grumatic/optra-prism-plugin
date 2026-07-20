const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');

const API_KEY = 'opaque settings key';
const MODULE_PATHS = ['../lib/config', '../lib/settings'];

let homeDir;
let projectDir;
let originalEnv;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clearModules() {
  for (const modulePath of MODULE_PATHS) delete require.cache[require.resolve(modulePath)];
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-settings-test-'));
  projectDir = path.join(homeDir, 'project');
  fs.mkdirSync(projectDir);
  originalEnv = new Map([
    'HOME',
    'PRISM_API_KEY',
    'PRISM_INGEST_URL',
    'CLAUDE_PLUGIN_OPTION_APIKEY',
  ].map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }]));
  process.env.HOME = homeDir;
  writeJson(path.join(homeDir, '.prism', 'config.json'), {
    apiKey: API_KEY,
    ingest_url: 'https://ingest.example/base/',
  });
  clearModules();
});

afterEach(() => {
  for (const [key, original] of originalEnv) {
    if (original.present) process.env[key] = original.value;
    else delete process.env[key];
  }
  clearModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('maps user, project, and local install scopes to their exact settings files', () => {
  const settings = require('../lib/settings');

  assert.equal(settings.pathForScope('user', projectDir),
    path.join(homeDir, '.claude', 'settings.json'));
  assert.equal(settings.pathForScope('project', projectDir),
    path.join(projectDir, '.claude', 'settings.json'));
  assert.equal(settings.pathForScope('local', projectDir),
    path.join(projectDir, '.claude', 'settings.local.json'));
  assert.throws(() => settings.pathForScope('other', projectDir), /unknown scope/);
});

test('overlays effective env per key in user to project to local order', () => {
  const settings = require('../lib/settings');
  const files = {
    user: settings.pathForScope('user', projectDir),
    project: settings.pathForScope('project', projectDir),
    local: settings.pathForScope('local', projectDir),
  };
  writeJson(files.user, { env: { SHARED: 'user', USER_ONLY: 'user' } });
  writeJson(files.project, { env: { SHARED: 'project', PROJECT_ONLY: 'project' } });
  writeJson(files.local, { env: { SHARED: 'local', LOCAL_ONLY: 'local' } });

  assert.deepEqual(settings.readEffectiveSettings(projectDir), {
    env: {
      SHARED: 'local',
      USER_ONLY: 'user',
      PROJECT_ONLY: 'project',
      LOCAL_ONLY: 'local',
    },
    sources: {
      SHARED: 'local',
      USER_ONLY: 'user',
      PROJECT_ONLY: 'project',
      LOCAL_ONLY: 'local',
    },
    files,
  });
});

test('settings keys cannot create inherited effective OTEL values', () => {
  const settings = require('../lib/settings');
  const userFile = settings.pathForScope('user', projectDir);
  writeJson(userFile, {
    env: JSON.parse('{"__proto__":{"OTEL_LOGS_EXPORTER":"otlp"}}'),
  });

  const effective = settings.readEffectiveSettings(projectDir);

  assert.equal(Object.getPrototypeOf(effective.env), Object.prototype);
  assert.equal(Object.hasOwn(effective.env, '__proto__'), true);
  assert.equal(Object.hasOwn(effective.env, 'OTEL_LOGS_EXPORTER'), false);
  assert.equal(effective.env.OTEL_LOGS_EXPORTER, undefined);
  assert.equal(settings.checkOtelSettings({ projectDir }).ok, false);
});

test('detects the exact installed scope for the active project', () => {
  const settings = require('../lib/settings');
  const registry = settings.INSTALLED_PLUGINS;

  writeJson(registry, { plugins: { [settings.PLUGIN_ID]: [{ scope: 'user' }] } });
  assert.equal(settings.detectInstallScope(projectDir), 'user');

  writeJson(registry, { plugins: { [settings.PLUGIN_ID]: [
    { scope: 'user' },
    { scope: 'project', projectPath: projectDir },
  ] } });
  assert.equal(settings.detectInstallScope(projectDir), 'project');

  writeJson(registry, { plugins: { [settings.PLUGIN_ID]: [
    { scope: 'project', projectPath: projectDir },
    { scope: 'local', projectPath: projectDir },
  ] } });
  assert.equal(settings.detectInstallScope(projectDir), 'local');
  assert.equal(settings.detectInstallScope(path.join(homeDir, 'other-project')), null);
});

test('builds OTEL settings only from config.json and preserves the opaque key', () => {
  process.env.PRISM_API_KEY = 'ignored-env-key';
  process.env.PRISM_INGEST_URL = 'https://ignored-env.example';
  process.env.CLAUDE_PLUGIN_OPTION_APIKEY = 'ignored-user-config-key';

  const { buildExpectedOtelEnv, OTEL_KEYS } = require('../lib/settings');
  const expected = buildExpectedOtelEnv();

  assert.equal(expected.apiKey, API_KEY);
  assert.equal(expected.otelEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    'https://ingest.example/base/v1/logs');
  assert.equal(expected.otelEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    'https://ingest.example/base/v1/metrics');
  assert.match(expected.otelEnv.OTEL_EXPORTER_OTLP_HEADERS,
    new RegExp(`^x-api-key=${encodeURIComponent(API_KEY)}(?:,|$)`));
  assert.equal(expected.otelEnv.OTEL_LOG_ASSISTANT_RESPONSES, '0');
  assert.ok(OTEL_KEYS.includes('OTEL_LOG_ASSISTANT_RESPONSES'));
});

test('sync writes only the requested target and never repairs other layers', () => {
  const settings = require('../lib/settings');
  const userFile = settings.pathForScope('user', projectDir);
  const projectFile = settings.pathForScope('project', projectDir);
  const localFile = settings.pathForScope('local', projectDir);
  const userBefore = { env: { OTEL_LOGS_EXPORTER: 'user-stale', USER_ONLY: 'keep' } };
  const localBefore = { env: { OTEL_LOGS_EXPORTER: 'local-stale', LOCAL_ONLY: 'keep' } };
  writeJson(userFile, userBefore);
  writeJson(projectFile, { permissions: { allow: ['Bash(npm test)'] }, env: { PROJECT_ONLY: 'keep' } });
  writeJson(localFile, localBefore);

  assert.equal(settings.syncOtelSettings({ scope: 'project', projectDir }), true);

  assert.deepEqual(readJson(userFile), userBefore);
  assert.deepEqual(readJson(localFile), localBefore);
  const projected = readJson(projectFile);
  assert.equal(projected.env.PROJECT_ONLY, 'keep');
  assert.equal(projected.env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.deepEqual(projected.permissions, { allow: ['Bash(npm test)'] });
  assert.deepEqual(settings.checkOtelSettings({ projectDir }), {
    ok: false,
    mismatches: ['OTEL_LOGS_EXPORTER'],
  });
});

test('explicit removal clears only managed OTEL keys from its target', () => {
  const settings = require('../lib/settings');
  const localFile = settings.pathForScope('local', projectDir);
  writeJson(localFile, {
    enabledPlugins: { 'other-plugin@example': true },
    env: {
      UNRELATED: 'preserve',
      OTEL_LOG_ASSISTANT_RESPONSES: '0',
    },
  });

  assert.deepEqual(settings.removeOtelSettings({ scope: 'local', projectDir }), ['local']);
  assert.deepEqual(readJson(localFile), {
    enabledPlugins: { 'other-plugin@example': true },
    env: { UNRELATED: 'preserve' },
  });
});
