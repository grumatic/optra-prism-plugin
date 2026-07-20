const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const API_KEY = 'opaque setup key';
const MODULE_PATHS = ['../lib/setup', '../lib/settings', '../lib/config', '../lib/notify'];

let homeDir;
let projectDir;
let originalHome;

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

function captureOutput() {
  const logs = [];
  const errors = [];
  return {
    output: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
    logs,
    errors,
  };
}

function configFile() {
  return path.join(homeDir, '.prism', 'config.json');
}

function installAt(scope) {
  const entry = { scope };
  if (scope !== 'user') entry.projectPath = projectDir;
  writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [entry] },
  });
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-setup-apply-'));
  projectDir = path.join(homeDir, 'project');
  fs.mkdirSync(projectDir);
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  clearModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  clearModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('setup persists remote config and writes only the detected install scope', async () => {
  installAt('project');
  const existing = {
    ingest_url: 'http://127.0.0.1:9005/bootstrap',
    showRealtimeSummary: true,
    customField: { preserved: true },
  };
  writeJson(configFile(), existing);

  const userFile = path.join(homeDir, '.claude', 'settings.json');
  const projectFile = path.join(projectDir, '.claude', 'settings.json');
  const localFile = path.join(projectDir, '.claude', 'settings.local.json');
  const userBefore = { env: { OTEL_LOGS_EXPORTER: 'user-stale', USER_ONLY: 'preserve' } };
  const localBefore = { env: { OTEL_LOGS_EXPORTER: 'local-stale', LOCAL_ONLY: 'preserve' } };
  writeJson(userFile, userBefore);
  writeJson(projectFile, { env: { PROJECT_ONLY: 'preserve' } });
  writeJson(localFile, localBefore);

  let fetchedKey;
  let notifiedKey;
  const captured = captureOutput();
  const { applySetup } = require('../lib/setup');
  const exitCode = await applySetup({
    apiKey: API_KEY,
    projectDir,
    output: captured.output,
    fetchConfigFn: async (apiKey) => {
      fetchedKey = apiKey;
      return {
        status: 'server',
        config: {
          ingest_url: 'https://remote-ingest.example/base',
          dashboard_url: 'https://remote-dashboard.example',
        },
      };
    },
    notifyDashboardFn: async (apiKey) => {
      notifiedKey = apiKey;
      return { ok: true, httpStatus: 200, error: null };
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(fetchedKey, API_KEY);
  assert.equal(notifiedKey, undefined);
  assert.deepEqual(readJson(configFile()), {
    ...existing,
    apiKey: API_KEY,
    ingest_url: 'https://remote-ingest.example/base',
    dashboard_url: 'https://remote-dashboard.example',
  });
  assert.deepEqual(readJson(userFile), userBefore);
  assert.deepEqual(readJson(localFile), localBefore);
  const projected = readJson(projectFile);
  assert.equal(projected.env.PROJECT_ONLY, 'preserve');
  assert.equal(projected.env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.match(projected.env.OTEL_EXPORTER_OTLP_HEADERS, /x-api-key=opaque%20setup%20key/);
  assert.doesNotMatch(captured.logs.join('\n'), /Prism setup complete/);
  assert.match(captured.errors.join('\n'), /effective OTEL settings are overridden/);
  assert.doesNotMatch(captured.logs.join('\n'), /Restart Claude Code/);
  assert.equal(captured.logs.join('\n').includes(API_KEY), false);
});

test('backend authentication rejection leaves config and settings unchanged', async () => {
  installAt('user');
  const configBefore = { apiKey: 'existing-key', marker: 'preserve' };
  const settingsFile = path.join(homeDir, '.claude', 'settings.json');
  const settingsBefore = { env: { UNRELATED: 'preserve' } };
  writeJson(configFile(), configBefore);
  writeJson(settingsFile, settingsBefore);
  const { applySetup } = require('../lib/setup');

  for (const status of [401, 403]) {
    const captured = captureOutput();
    assert.equal(await applySetup({
      apiKey: API_KEY,
      projectDir,
      output: captured.output,
      fetchConfigFn: async () => ({ status: 'auth-error', authStatus: status }),
    }), 2);
    assert.match(captured.errors[0], new RegExp(`HTTP ${status}`));
    assert.deepEqual(readJson(configFile()), configBefore);
    assert.deepEqual(readJson(settingsFile), settingsBefore);
  }
});

test('setup reports notification failure without turning local success into failure', async () => {
  installAt('user');
  const captured = captureOutput();
  const { applySetup } = require('../lib/setup');

  assert.equal(await applySetup({
    apiKey: API_KEY,
    projectDir,
    output: captured.output,
    fetchConfigFn: async () => ({
      status: 'server',
      config: { ingest_url: 'https://remote-ingest.example' },
    }),
    notifyDashboardFn: async () => ({ ok: false, httpStatus: 503, error: 'HTTP 503' }),
  }), 0);

  assert.match(captured.logs.join('\n'), /Prism setup complete/);
  assert.deepEqual(captured.errors, [
    'Local setup succeeded, but the dashboard setup notification failed: HTTP 503.',
  ]);
});

test('successful remote config remains saved when OTEL projection cannot run', async () => {
  writeJson(configFile(), { marker: 'preserve' });
  const captured = captureOutput();
  const { applySetup } = require('../lib/setup');

  assert.equal(await applySetup({
    apiKey: API_KEY,
    projectDir,
    output: captured.output,
    fetchConfigFn: async () => ({
      status: 'server',
      config: { ingest_url: 'https://remote-ingest.example' },
    }),
    notifyDashboardFn: async () => ({ ok: true, httpStatus: 200, error: null }),
  }), 1);

  assert.deepEqual(readJson(configFile()), {
    marker: 'preserve',
    apiKey: API_KEY,
    ingest_url: 'https://remote-ingest.example',
  });
  assert.equal(captured.errors.length, 1);
  assert.match(captured.errors[0], /OTEL projection failed: unknown install scope/);
});

test('unavailable remote config leaves existing authority untouched', async () => {
  installAt('local');
  const before = { apiKey: 'existing-key', ingest_url: 'https://existing.example' };
  writeJson(configFile(), before);
  const captured = captureOutput();
  const { applySetup } = require('../lib/setup');

  assert.equal(await applySetup({
    apiKey: API_KEY,
    projectDir,
    output: captured.output,
    fetchConfigFn: async () => ({
      status: 'error',
      message: 'config endpoint returned HTTP 503',
      httpStatus: 503,
    }),
  }), 1);
  assert.deepEqual(readJson(configFile()), before);
  assert.deepEqual(captured.errors, ['ERROR: config endpoint returned HTTP 503']);
});
