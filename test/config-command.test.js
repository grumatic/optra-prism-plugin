require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');
const { LEGACY_HOST_VERSION, pinClaudeHostVersion } = require('./helpers/claude-host');

// These tests exercise hosts that still apply OTEL from project and local settings.
pinClaudeHostVersion(LEGACY_HOST_VERSION);

const MODULE_PATHS = ['../lib/config-command', '../lib/config', '../lib/settings'];
const API_KEY = 'secret opaque key';
// The repository checkout acts as an inline plugin root outside the plugin cache.
const PLUGIN_ROOT = path.resolve(__dirname, '..');

let homeDir;
let projectDir;
let originalHome;

function clearModules() {
  for (const modulePath of MODULE_PATHS) delete require.cache[require.resolve(modulePath)];
}

function configFile() {
  return path.join(homeDir, '.prism', 'config.json');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

function dataDir(root = path.join(homeDir, '.claude')) {
  return path.join(root, 'plugins', 'data', 'prism-inline');
}

// Mutating commands now need the plugin data directory (commands/config.md
// passes it); add the one that matches the default config root.
function loadMain() {
  const { main } = require('../lib/config-command');
  return (argv, output, options) => {
    const mutating = argv[0] === 'set' || argv[0] === 'unset';
    const args = mutating && !argv.includes('--data-dir')
      ? [...argv, '--data-dir', dataDir()]
      : argv;
    return main(args, output, { pluginRoot: PLUGIN_ROOT, ...options });
  };
}

function installAt(scope) {
  const entry = { scope, installPath: PLUGIN_ROOT };
  if (scope !== 'user') entry.projectPath = projectDir;
  writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [entry] },
  });
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-config-command-'));
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

test('show emits only the two user-editable keys and never apiKey', () => {
  writeJson(configFile(), {
    apiKey: API_KEY,
    show_realtime_summary: true,
    prismThreshold: 7,
    ingest_url: 'https://ingest.example',
    internalField: 'hidden',
  });
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main(['show'], captured.output), 0);
  assert.match(captured.logs[0], /show_realtime_summary\n  Current: true/);
  assert.match(captured.logs[0], /ingest_url\n  Current: "https:\/\/ingest\.example"/);
  assert.match(captured.logs[0], /Type: boolean/);
  assert.match(captured.logs[0], /Values: HTTPS URL or loopback HTTP URL/);
  assert.equal(captured.logs.join('\n').includes(API_KEY), false);
  assert.doesNotMatch(captured.logs[0], /apiKey|internalField|showRealtimeSummary/);
});

test('show renders a missing ingest_url explicitly', () => {
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main(['show'], captured.output), 0);
  assert.match(captured.logs[0], /show_realtime_summary\n  Current: false/);
  assert.match(captured.logs[0], /ingest_url\n  Current: not set/);
  assert.match(captured.logs[0], /\/prism:config help/);
});

test('set and unset persist the boolean value while preserving unrelated config', () => {
  writeJson(configFile(), { apiKey: API_KEY, custom: 'preserve' });
  const main = loadMain();

  let captured = captureOutput();
  assert.equal(main(['set', 'show_realtime_summary', 'true'], captured.output), 0);
  assert.equal(readJson(configFile()).show_realtime_summary, true);
  assert.match(captured.logs.at(-1), /next Hook invocation/);

  captured = captureOutput();
  assert.equal(main(['unset', 'show_realtime_summary'], captured.output), 0);
  assert.equal(Object.hasOwn(readJson(configFile()), 'show_realtime_summary'), false);
  assert.match(captured.logs[0], /effective value is false/);
  assert.equal(readJson(configFile()).custom, 'preserve');
});

test('help describes every field, accepted value, and apply behavior', () => {
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main(['help'], captured.output), 0);
  assert.match(captured.logs[0], /show_realtime_summary/);
  assert.match(captured.logs[0], /Values: true \| false/);
  assert.match(captured.logs[0], /ingest_url/);
  assert.match(captured.logs[0], /HTTPS URL or loopback HTTP URL/);
  assert.match(captured.logs[0], /Restart Claude Code/);
  assert.match(captured.logs[0], /\/prism:setup KEY/);
  assert.doesNotMatch(captured.logs[0], /showRealtimeSummary/);
});

test('rejects apiKey, unsupported keys, and invalid values without mutation', () => {
  const before = { apiKey: API_KEY, marker: 'preserve' };
  writeJson(configFile(), before);
  const main = loadMain();

  for (const argv of [
    ['set', 'apiKey', 'replacement'],
    ['unset', 'apiKey'],
    ['set', 'environment', 'test'],
    ['set', 'prismThreshold', '4'],
    ['set', 'showRealtimeSummary', 'true'],
    ['set', 'show_realtime_summary', 'yes'],
    ['set', 'ingest_url', '/relative/path'],
    ['set', 'ingest_url', 'ftp://ingest.example'],
    ['set', 'ingest_url', 'http://remote.example/path'],
    ['set', 'ingest_url', 'https://user:secret@ingest.example/path'],
    ['set', 'ingest_url', 'https://ingest.example/path?workspace=test'],
    ['set', 'ingest_url', 'https://ingest.example/path#fragment'],
  ]) {
    const captured = captureOutput();
    assert.equal(main(argv, captured.output), 2, argv.join(' '));
    assert.match(captured.errors[0], /^\[prism:config\] /);
    assert.deepEqual(readJson(configFile()), before);
  }
});

test('ingest_url accepts HTTPS and loopback HTTP without rewriting the value', () => {
  const main = loadMain();

  for (const value of [
    'http://127.0.0.1:9005/path/',
    'https://ingest.example/path/',
  ]) {
    const captured = captureOutput();
    assert.equal(main(['set', 'ingest_url', value], captured.output), 0);
    assert.equal(readJson(configFile()).ingest_url, value);
  }
});

test('ingest_url can bootstrap config before an API key or install scope exists', () => {
  writeJson(configFile(), { marker: 'preserve' });
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main([
    'set',
    'ingest_url',
    'http://127.0.0.1:9005/bootstrap/',
    '--project-dir',
    projectDir,
  ], captured.output), 0);
  assert.deepEqual(readJson(configFile()), {
    marker: 'preserve',
    ingest_url: 'http://127.0.0.1:9005/bootstrap/',
  });
  assert.match(captured.logs.join('\n'), /Run \/prism:setup KEY/);
  assert.equal(fs.existsSync(path.join(projectDir, '.claude')), false);
});

test('ingest_url syncs the detected target and requires restart when effective', () => {
  writeJson(configFile(), { apiKey: API_KEY });
  installAt('local');
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main([
    'set',
    'ingest_url',
    'https://new-ingest.example/base/',
    '--project-dir',
    projectDir,
  ], captured.output), 0);
  const localSettings = readJson(path.join(projectDir, '.claude', 'settings.local.json'));
  assert.equal(localSettings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    'https://new-ingest.example/base/v1/logs');
  assert.equal(localSettings.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    'https://new-ingest.example/base/v1/metrics');
  assert.match(captured.logs.join('\n'), /local install scope/);
  assert.match(captured.logs.join('\n'), /Restart Claude Code/);
  assert.doesNotMatch(captured.logs.join('\n'), /next Hook invocation/);
});

test('unsetting ingest_url removes only installed-scope OTEL settings', () => {
  writeJson(configFile(), { apiKey: API_KEY, ingest_url: 'https://old-ingest.example' });
  installAt('local');
  const localFile = path.join(projectDir, '.claude', 'settings.local.json');
  writeJson(localFile, {
    env: {
      KEEP_ME: 'yes',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_HEADERS: 'stale-secret',
    },
  });
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main([
    'unset', 'ingest_url', '--project-dir', projectDir,
  ], captured.output), 0);
  assert.equal(Object.hasOwn(readJson(configFile()), 'ingest_url'), false);
  assert.deepEqual(readJson(localFile), { env: { KEEP_ME: 'yes' } });
  assert.match(captured.logs[0], /effective value is not set/);
  assert.match(captured.logs.join('\n'), /removed from the local install scope/);
  assert.match(captured.logs.join('\n'), /Restart Claude Code/);
});

test('unsetting ingest_url reports OTEL values owned by another settings layer', () => {
  writeJson(configFile(), { apiKey: API_KEY, ingest_url: 'https://old-ingest.example' });
  installAt('project');
  writeJson(path.join(projectDir, '.claude', 'settings.json'), {
    env: { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_HEADERS: 'project-secret' },
  });
  const localFile = path.join(projectDir, '.claude', 'settings.local.json');
  writeJson(localFile, { env: { OTEL_LOGS_EXPORTER: 'local-override' } });
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main([
    'unset', 'ingest_url', '--project-dir', projectDir,
  ], captured.output), 1);
  assert.equal(Object.hasOwn(readJson(configFile()), 'ingest_url'), false);
  assert.deepEqual(readJson(path.join(projectDir, '.claude', 'settings.json')), {});
  assert.equal(readJson(localFile).env.OTEL_LOGS_EXPORTER, 'local-override');
  assert.match(captured.errors[0], /effective OTEL values remain in another settings layer/);
});

test('ingest_url is refused without a scope and remains persisted when the effective projection fails', () => {
  writeJson(configFile(), { apiKey: API_KEY });
  let captured = captureOutput();
  const main = loadMain();

  assert.equal(main([
    'set', 'ingest_url', 'https://refused-without-scope.example',
    '--project-dir', projectDir,
  ], captured.output), 1);
  // The scope is resolved before the first write, so nothing was saved.
  assert.equal(Object.hasOwn(readJson(configFile()), 'ingest_url'), false);
  assert.match(captured.errors[0], /not changed.*install scope is unknown/);

  installAt('project');
  writeJson(path.join(projectDir, '.claude', 'settings.local.json'), {
    env: { OTEL_LOGS_EXPORTER: 'higher-precedence-override' },
  });
  captured = captureOutput();
  assert.equal(main([
    'set', 'ingest_url', 'https://saved-with-override.example',
    '--project-dir', projectDir,
  ], captured.output), 1);
  assert.equal(readJson(configFile()).ingest_url, 'https://saved-with-override.example');
  assert.equal(
    readJson(path.join(projectDir, '.claude', 'settings.json')).env.OTEL_LOGS_EXPORTER,
    'otlp',
  );
  assert.match(captured.errors[0], /effective OTEL settings are out of sync: OTEL_LOGS_EXPORTER/);
  assert.doesNotMatch(captured.logs.join('\n'), /Restart Claude Code/);
});

test('settings read errors are reported instead of becoming an unknown scope', () => {
  writeJson(configFile(), { apiKey: API_KEY });
  const installed = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, '{invalid json');
  const captured = captureOutput();
  const main = loadMain();

  assert.equal(main([
    'set', 'ingest_url', 'https://saved-before-read-error.example',
    '--project-dir', projectDir,
  ], captured.output), 1);
  assert.equal(Object.hasOwn(readJson(configFile()), 'ingest_url'), false);
  assert.match(captured.errors[0], /Unable to read JSON.*installed_plugins\.json/);
  assert.doesNotMatch(captured.errors[0], /install scope is unknown/);
});

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('ingest_url under CLAUDE_CONFIG_DIR projects to the settings file in that directory', () => {
  const cfg = path.join(homeDir, 'elsewhere', 'cfg');
  writeJson(configFile(), { apiKey: API_KEY });
  writeJson(path.join(cfg, 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [{ scope: 'user', installPath: PLUGIN_ROOT }] },
  });
  const captured = captureOutput();
  const main = loadMain();

  const status = withEnv({ CLAUDE_CONFIG_DIR: cfg }, () => main([
    'set', 'ingest_url', 'https://cfg-ingest.example/base/',
    '--project-dir', projectDir,
    '--data-dir', dataDir(cfg),
  ], captured.output));

  assert.equal(status, 0, captured.errors.join('\n'));
  const userSettings = readJson(path.join(cfg, 'settings.json'));
  assert.equal(userSettings.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    'https://cfg-ingest.example/base/v1/logs');
  assert.equal(fs.existsSync(path.join(homeDir, '.claude', 'settings.json')), false);
  assert.match(captured.logs.join('\n'), /user install scope/);
});

test('a context mismatch is refused before the config file changes', () => {
  const cfg = path.join(homeDir, 'cfg');
  const before = { apiKey: API_KEY, marker: 'preserve' };
  writeJson(configFile(), before);
  const main = loadMain();

  // The data directory belongs to the default root, but the command runs under cfg.
  let captured = captureOutput();
  let status = withEnv({ CLAUDE_CONFIG_DIR: cfg }, () => main([
    'set', 'show_realtime_summary', 'true', '--data-dir', dataDir(),
  ], captured.output));
  assert.equal(status, 1);
  assert.match(captured.errors[0], /CLAUDE_PLUGIN_DATA does not match the inline plugin root/);
  assert.deepEqual(readJson(configFile()), before);

  // The reverse: CLAUDE_CONFIG_DIR is not visible, but the data directory sits in cfg.
  captured = captureOutput();
  status = main([
    'set', 'show_realtime_summary', 'true', '--data-dir', dataDir(cfg),
  ], captured.output);
  assert.equal(status, 1);
  assert.match(captured.errors[0], /CLAUDE_CONFIG_DIR is not visible to this command/);
  assert.match(captured.errors[0], /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB/);
  assert.deepEqual(readJson(configFile()), before);
});

test('set and unset refuse without a plugin data directory, show and help do not need one', () => {
  const before = { apiKey: API_KEY };
  writeJson(configFile(), before);
  const { main } = require('../lib/config-command');
  const options = { pluginRoot: PLUGIN_ROOT };

  for (const argv of [['set', 'show_realtime_summary', 'true'], ['unset', 'show_realtime_summary']]) {
    const captured = captureOutput();
    assert.equal(main(argv, captured.output, options), 1, argv.join(' '));
    assert.match(captured.errors[0], /plugin data directory \(CLAUDE_PLUGIN_DATA\) is not available/);
    assert.deepEqual(readJson(configFile()), before);
  }
  for (const action of ['show', 'help']) {
    const captured = captureOutput();
    assert.equal(main([action], captured.output, options), 0, action);
  }
});

test('config refuses while CLAUDE_CODE_PLUGIN_CACHE_DIR or an invalid CLAUDE_CONFIG_DIR is set', () => {
  const before = { apiKey: API_KEY };
  writeJson(configFile(), before);
  const main = loadMain();

  let captured = captureOutput();
  let status = withEnv({ CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(homeDir, 'cache') }, () => main([
    'set', 'show_realtime_summary', 'true',
  ], captured.output));
  assert.equal(status, 1);
  assert.match(captured.errors[0], /CLAUDE_CODE_PLUGIN_CACHE_DIR is set/);

  captured = captureOutput();
  status = withEnv({ CLAUDE_CONFIG_DIR: '~/cfg' }, () => main([
    'set', 'show_realtime_summary', 'true',
  ], captured.output));
  assert.equal(status, 1);
  assert.match(captured.errors[0], /"~" is not expanded/);
  assert.deepEqual(readJson(configFile()), before);
});

test('options are accepted in either order and rejected anywhere else', () => {
  writeJson(configFile(), { apiKey: API_KEY });
  const { main } = require('../lib/config-command');
  const options = { pluginRoot: PLUGIN_ROOT };

  let captured = captureOutput();
  assert.equal(main([
    'set', 'show_realtime_summary', 'true',
    '--data-dir', dataDir(), '--project-dir', projectDir,
  ], captured.output, options), 0, captured.errors.join('\n'));

  captured = captureOutput();
  assert.equal(main([
    'set', '--data-dir', dataDir(), 'show_realtime_summary', 'true',
  ], captured.output, options), 2);
  assert.match(captured.errors[0], /--data-dir must be a final option/);
});
