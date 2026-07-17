const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');
const { spawnSync } = require('node:child_process');

const API_KEY = 'prism_setup_apply_test_key';
let homeDir;
let originalHome;
let originalPluginKey;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadSetup() {
  for (const modulePath of ['../lib/setup', '../lib/settings', '../lib/config', '../lib/notify']) {
    delete require.cache[require.resolve(modulePath)];
  }
  return require('../lib/setup');
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

function userSettingsPath() {
  return path.join(homeDir, '.claude', 'settings.json');
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-setup-apply-'));
  originalHome = process.env.HOME;
  originalPluginKey = process.env.CLAUDE_PLUGIN_OPTION_apiKey;
  process.env.HOME = homeDir;
  delete process.env.CLAUDE_PLUGIN_OPTION_apiKey;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPluginKey === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_apiKey;
  else process.env.CLAUDE_PLUGIN_OPTION_apiKey = originalPluginKey;
  fs.rmSync(homeDir, { recursive: true, force: true });
  for (const modulePath of ['../lib/setup', '../lib/settings', '../lib/config', '../lib/notify']) {
    delete require.cache[require.resolve(modulePath)];
  }
});

test('apply preserves config fields, defaults the threshold, and secures config paths', async () => {
  const configFile = path.join(homeDir, '.prism', 'config.json');
  const original = {
    apiKey: 'prism_old_key',
    ingest_url: 'https://ingest.example',
    showRealtimeSummary: false,
    customField: { preserved: true },
  };
  writeJson(configFile, original);
  writeJson(path.join(homeDir, '.prism', 'config-cache.json'), { stale: true });

  const { applySetup } = loadSetup();
  const captured = captureOutput();
  const exitCode = await applySetup({
    apiKey: API_KEY,
    output: captured.output,
    cacheConfigFn: async () => 0,
    notifyDashboardFn: async () => 0,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(readJson(configFile), { ...original, apiKey: API_KEY, prismThreshold: 4 });
  assert.equal(fs.statSync(path.dirname(configFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(homeDir, '.prism', 'config-cache.json')), false);
  assert.equal(captured.logs.join('\n').includes(API_KEY), false);
});

test('apply reports an invalid key with exit code 2', () => {
  const result = spawnSync(process.execPath, ['lib/setup.js', 'apply'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOME: homeDir, PRISM_API_KEY: 'invalid' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: PRISM_API_KEY=/);
  assert.equal(fs.existsSync(path.join(homeDir, '.prism')), false);
});

test('apply requires confirmation before changing an existing scope and writes nothing', async () => {
  const before = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTHER: 'preserve' } };
  writeJson(userSettingsPath(), before);
  const { applySetup } = loadSetup();
  const captured = captureOutput();

  const exitCode = await applySetup({
    apiKey: API_KEY,
    scope: 'project',
    projectDir: path.join(homeDir, 'project'),
    output: captured.output,
  });

  assert.equal(exitCode, 3);
  assert.match(captured.logs[0], /^CONFIRM_REQUIRED: /);
  assert.deepEqual(readJson(userSettingsPath()), before);
  assert.equal(fs.existsSync(path.join(homeDir, '.prism')), false);
});

test('confirmed scope migration syncs the target and removes OTEL from the other scope', async () => {
  writeJson(userSettingsPath(), {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer prism_old_key',
      OTHER: 'preserve',
    },
  });
  const projectDir = path.join(homeDir, 'project');
  const { applySetup } = loadSetup();
  const captured = captureOutput();

  const exitCode = await applySetup({
    apiKey: API_KEY,
    scope: 'project',
    projectDir,
    confirm: true,
    output: captured.output,
    cacheConfigFn: async () => 0,
    notifyDashboardFn: async () => 0,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(readJson(userSettingsPath()), { env: { OTHER: 'preserve' } });
  const projectSettings = readJson(path.join(projectDir, '.claude', 'settings.local.json'));
  assert.equal(projectSettings.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(projectSettings.env.OTEL_EXPORTER_OTLP_HEADERS.includes(API_KEY), true);
  assert.equal(captured.logs.join('\n').includes(API_KEY), false);
});

test('auth rejection does not write telemetry settings', async () => {
  const { applySetup } = loadSetup();
  const captured = captureOutput();

  const exitCode = await applySetup({
    apiKey: API_KEY,
    scope: 'user',
    output: captured.output,
    cacheConfigFn: async () => 2,
  });

  assert.equal(exitCode, 2);
  assert.equal(fs.existsSync(userSettingsPath()), false);
});

test('check-existing reports key presence without printing the key', async () => {
  writeJson(path.join(homeDir, '.prism', 'config.json'), { apiKey: API_KEY });
  const { main } = loadSetup();
  const captured = captureOutput();

  assert.equal(await main(['apply', '--check-existing'], captured.output), 0);
  assert.deepEqual(captured.logs, ['KEY_PRESENT']);
  assert.equal(captured.logs.join('\n').includes(API_KEY), false);
});
