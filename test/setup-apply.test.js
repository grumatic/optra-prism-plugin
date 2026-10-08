require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');
const { LEGACY_HOST_VERSION, pinClaudeHostVersion } = require('./helpers/claude-host');

// These tests exercise hosts that still apply OTEL from project and local settings.
pinClaudeHostVersion(LEGACY_HOST_VERSION);
const { bindingDigest } = require('../lib/binding');

const ROOT = path.resolve(__dirname, '..');
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

function dataDir(root = path.join(homeDir, '.claude')) {
  return path.join(root, 'plugins', 'data', 'prism-inline');
}

// The repository checkout is an inline plugin root, so its data directory is the
// one Claude Code would give it under the default config root.
function loadApplySetup() {
  const { applySetup } = require('../lib/setup');
  return (options) => applySetup({ dataDir: dataDir(), ...options });
}

function installAt(scope) {
  const entry = { scope, installPath: ROOT };
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
  const applySetup = loadApplySetup();
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
  const persisted = readJson(configFile());
  assert.deepEqual({ ...persisted, binding: undefined }, {
    customField: { preserved: true },
    show_realtime_summary: true,
    apiKey: API_KEY,
    ingest_url: 'https://remote-ingest.example/base',
    dashboard_url: 'https://remote-dashboard.example',
    binding: undefined,
  });
  assert.equal(
    persisted.binding.digest,
    bindingDigest(API_KEY, 'https://remote-ingest.example/base'),
  );
  assert.equal(persisted.binding.host, 'remote-ingest.example');
  assert.equal(persisted.binding.bound_at, new Date(persisted.binding.bound_at).toISOString());
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

test('setup binds scope detection to the plugin root executing setup', async () => {
  const otherRoot = path.join(homeDir, 'other-plugin-root');
  fs.mkdirSync(otherRoot);
  writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: {
      'prism@optra-prism': [
        { scope: 'local', projectPath: projectDir, installPath: otherRoot },
        { scope: 'user', installPath: ROOT },
      ],
    },
  });
  const captured = captureOutput();
  const applySetup = loadApplySetup();

  assert.equal(await applySetup({
    apiKey: API_KEY,
    projectDir,
    pluginRoot: ROOT,
    output: captured.output,
    fetchConfigFn: async () => ({
      status: 'server',
      config: { ingest_url: 'https://remote-ingest.example' },
    }),
    notifyDashboardFn: async () => ({ ok: true, httpStatus: 200, error: null }),
  }), 0);

  assert.match(captured.logs.join('\n'), /Scope: user/);
  assert.equal(fs.existsSync(path.join(homeDir, '.claude', 'settings.json')), true);
  assert.equal(
    fs.existsSync(path.join(projectDir, '.claude', 'settings.local.json')),
    false,
  );
});

test('backend authentication rejection leaves config and settings unchanged', async () => {
  installAt('user');
  const configBefore = { apiKey: 'existing-key', marker: 'preserve' };
  const settingsFile = path.join(homeDir, '.claude', 'settings.json');
  const settingsBefore = { env: { UNRELATED: 'preserve' } };
  writeJson(configFile(), configBefore);
  writeJson(settingsFile, settingsBefore);
  const applySetup = loadApplySetup();

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
  const setupRunId = 'c35cc706-9b9f-48d2-bfc8-b67ea88a37c5';
  let generated = 0;
  const notifiedSetupRunIds = [];
  const captured = captureOutput();
  const applySetup = loadApplySetup();

  assert.equal(await applySetup({
    apiKey: API_KEY,
    projectDir,
    output: captured.output,
    fetchConfigFn: async () => ({
      status: 'server',
      config: { ingest_url: 'https://remote-ingest.example' },
    }),
    createSetupRunIdFn: () => {
      generated += 1;
      return setupRunId;
    },
    notifyDashboardFn: async (_apiKey, receivedSetupRunId) => {
      notifiedSetupRunIds.push(receivedSetupRunId);
      return { ok: false, httpStatus: 503, error: 'HTTP 503' };
    },
  }), 0);

  assert.equal(generated, 1);
  assert.deepEqual(notifiedSetupRunIds, [setupRunId]);
  assert.match(captured.logs.join('\n'), /Prism setup complete/);
  assert.deepEqual(captured.errors, [
    'Local setup succeeded, but the dashboard setup notification failed: HTTP 503.',
  ]);
});

test('setup creates one run id per successful invocation and does not persist or log it', async () => {
  installAt('user');
  const setupRunIds = [
    'c35cc706-9b9f-48d2-bfc8-b67ea88a37c5',
    '3ef8b37f-a578-4111-b707-31ccb62ce2f9',
  ];
  let generated = 0;
  const notifications = [];
  const captured = captureOutput();
  const applySetup = loadApplySetup();
  const options = {
    apiKey: API_KEY,
    projectDir,
    output: captured.output,
    fetchConfigFn: async () => ({
      status: 'server',
      config: { ingest_url: 'https://remote-ingest.example' },
    }),
    createSetupRunIdFn: () => setupRunIds[generated++],
    notifyDashboardFn: async (apiKey, setupRunId) => {
      notifications.push({ apiKey, setupRunId });
      return { ok: true, httpStatus: 200, error: null };
    },
  };

  assert.equal(await applySetup(options), 0);
  assert.equal(await applySetup(options), 0);

  assert.equal(generated, 2);
  assert.deepEqual(notifications, setupRunIds.map((setupRunId) => ({
    apiKey: API_KEY,
    setupRunId,
  })));
  const persistedConfig = [
    fs.readFileSync(configFile(), 'utf8'),
    fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'),
  ].join('\n');
  const output = [...captured.logs, ...captured.errors].join('\n');
  for (const setupRunId of setupRunIds) {
    assert.equal(persistedConfig.includes(setupRunId), false);
    assert.equal(output.includes(setupRunId), false);
  }
});

test('setup is refused before the config file changes when the install scope is unknown', async () => {
  const before = { marker: 'preserve' };
  writeJson(configFile(), before);
  const captured = captureOutput();
  const applySetup = loadApplySetup();

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

  assert.deepEqual(readJson(configFile()), before);
  assert.equal(captured.errors.length, 1);
  assert.match(captured.errors[0], /setup refused; no Prism config was written/);
  assert.match(captured.errors[0], /unknown install scope/);
});

test('unavailable remote config leaves existing authority untouched', async () => {
  installAt('local');
  const before = { apiKey: 'existing-key', ingest_url: 'https://existing.example' };
  writeJson(configFile(), before);
  const captured = captureOutput();
  const applySetup = loadApplySetup();

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

test('setup fails visibly when the active version marker cannot be published', async () => {
  installAt('user');
  const pluginData = dataDir();
  const captured = captureOutput();
  const applySetup = loadApplySetup();
  let generated = 0;
  let notified = false;

  assert.equal(await applySetup({
    apiKey: API_KEY,
    projectDir,
    dataDir: pluginData,
    output: captured.output,
    fetchConfigFn: async () => ({
      status: 'server',
      config: { ingest_url: 'https://remote-ingest.example' },
    }),
    readCurrentVersionFn: () => '1.2.3',
    writeActiveVersionFn: () => false,
    createSetupRunIdFn: () => {
      generated += 1;
      return 'c35cc706-9b9f-48d2-bfc8-b67ea88a37c5';
    },
    notifyDashboardFn: async () => {
      notified = true;
      return { ok: true, httpStatus: 200, error: null };
    },
  }), 1);

  assert.equal(generated, 0);
  assert.equal(notified, false);
  assert.match(captured.errors.join('\n'), /active plugin version could not be published/);
  const userSettings = readJson(path.join(homeDir, '.claude', 'settings.json'));
  assert.equal(
    userSettings.otelHeadersHelper,
    path.join(pluginData, 'bin', 'prism-otel-headers-helper.js'),
  );
});

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  Object.assign(process.env, values);
  const restore = () => {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  return Promise.resolve(result).finally(restore);
}

const serverConfig = () => ({
  fetchConfigFn: async () => ({
    status: 'server',
    config: { ingest_url: 'https://remote-ingest.example' },
  }),
  notifyDashboardFn: async () => ({ ok: true, httpStatus: 200, error: null }),
});

test('setup under CLAUDE_CONFIG_DIR projects to that config dir and records the install', async () => {
  const cfg = path.join(homeDir, 'elsewhere', 'cfg');
  writeJson(path.join(cfg, 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [{ scope: 'user', installPath: ROOT }] },
  });
  // ~/.prism exists from an earlier setup, which is when registration may write.
  writeJson(configFile(), { marker: 'preserve' });
  const absent = path.join(homeDir, 'deleted-cfg');
  writeJson(path.join(homeDir, '.prism', 'installs.json'), {
    version: 1,
    overflow: false,
    roots: {
      [absent]: { firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
    },
  });
  const captured = captureOutput();
  const applySetup = loadApplySetup();

  const exitCode = await withEnv({ CLAUDE_CONFIG_DIR: cfg }, () => applySetup({
    apiKey: API_KEY,
    projectDir,
    dataDir: dataDir(cfg),
    output: captured.output,
    hostVersion: '2.1.281',
    ...serverConfig(),
  }));

  assert.equal(exitCode, 0, captured.errors.join('\n'));
  assert.match(captured.logs.join('\n'), /Scope: user/);
  assert.match(captured.logs.join('\n'), new RegExp(`Settings file: ${cfg}/settings\\.json`));
  const settings = readJson(path.join(cfg, 'settings.json'));
  assert.equal(settings.env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.equal(settings.otelHeadersHelper, path.join(dataDir(cfg), 'bin', 'prism-otel-headers-helper.js'));
  assert.equal(fs.existsSync(path.join(homeDir, '.claude')), false);
  assert.equal(fs.readFileSync(path.join(dataDir(cfg), 'last-version.txt'), 'utf8').trim().length > 0, true);

  // The current root is recorded (canonical form) and the absent root pruned.
  const inventory = readJson(path.join(homeDir, '.prism', 'installs.json'));
  assert.deepEqual(Object.keys(inventory.roots), [fs.realpathSync(cfg)]);
  assert.equal(
    fs.readFileSync(path.join(homeDir, '.prism', 'prism-off.settings.json'), 'utf8').includes('"enabledPlugins"'),
    true,
  );
});

test('a context mismatch is refused before ~/.prism/config.json is written', async () => {
  const cfg = path.join(homeDir, 'cfg');
  writeJson(path.join(cfg, 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [{ scope: 'user', installPath: ROOT }] },
  });
  const applySetup = loadApplySetup();

  // The data directory belongs to the default root while the command runs under cfg.
  let captured = captureOutput();
  let exitCode = await withEnv({ CLAUDE_CONFIG_DIR: cfg }, () => applySetup({
    apiKey: API_KEY, projectDir, dataDir: dataDir(), output: captured.output, ...serverConfig(),
  }));
  assert.equal(exitCode, 1);
  assert.match(captured.errors[0], /setup refused; no Prism config was written/);
  assert.match(captured.errors[0], /does not match the inline plugin root/);
  assert.equal(fs.existsSync(path.join(homeDir, '.prism')), false);

  // CLAUDE_CONFIG_DIR is not visible but the data directory belongs to cfg.
  captured = captureOutput();
  exitCode = await applySetup({
    apiKey: API_KEY, projectDir, dataDir: dataDir(cfg), output: captured.output, ...serverConfig(),
  });
  assert.equal(exitCode, 1);
  assert.match(captured.errors[0], /CLAUDE_CONFIG_DIR is not visible to this command/);
  assert.equal(fs.existsSync(path.join(homeDir, '.prism')), false);
  assert.equal(fs.existsSync(path.join(cfg, 'settings.json')), false);
});

test('setup refuses without a plugin data directory or while CLAUDE_CODE_PLUGIN_CACHE_DIR is set', async () => {
  installAt('user');
  const { applySetup } = require('../lib/setup');

  let captured = captureOutput();
  assert.equal(await applySetup({
    apiKey: API_KEY, projectDir, output: captured.output, ...serverConfig(),
  }), 1);
  assert.match(captured.errors[0], /plugin data directory \(CLAUDE_PLUGIN_DATA\) is not available/);

  captured = captureOutput();
  assert.equal(await withEnv({ CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(homeDir, 'cache') }, () => applySetup({
    apiKey: API_KEY, projectDir, dataDir: dataDir(), output: captured.output, ...serverConfig(),
  })), 1);
  assert.match(captured.errors[0], /CLAUDE_CODE_PLUGIN_CACHE_DIR is set/);
  assert.equal(fs.existsSync(path.join(homeDir, '.prism')), false);
});

test('setup accepts a local-path marketplace root with prism-optra-prism data', async () => {
  installAt('user');
  const applySetup = loadApplySetup();
  const captured = captureOutput();

  const exitCode = await applySetup({
    apiKey: API_KEY,
    projectDir,
    dataDir: path.join(homeDir, '.claude', 'plugins', 'data', 'prism-optra-prism'),
    output: captured.output,
    ...serverConfig(),
  });

  assert.equal(exitCode, 0, captured.errors.join('\n'));
});

test('setup creates ~/.prism, records the current root, and never creates ~/.claude under CLAUDE_CONFIG_DIR', async () => {
  const cfg = path.join(homeDir, 'cfg');
  writeJson(path.join(cfg, 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [{ scope: 'user', installPath: ROOT }] },
  });
  const applySetup = loadApplySetup();
  const captured = captureOutput();

  const exitCode = await withEnv({ CLAUDE_CONFIG_DIR: cfg }, () => applySetup({
    apiKey: API_KEY, projectDir, dataDir: dataDir(cfg), output: captured.output, ...serverConfig(),
  }));

  // Setup created ~/.prism itself, so registration is allowed to write.
  assert.equal(exitCode, 0, captured.errors.join('\n'));
  assert.deepEqual(
    Object.keys(readJson(path.join(homeDir, '.prism', 'installs.json')).roots),
    [fs.realpathSync(cfg)],
  );
  assert.equal(fs.existsSync(path.join(homeDir, '.claude')), false);
});
