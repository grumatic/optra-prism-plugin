const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  afterEach,
  beforeEach,
  test,
} = require('node:test');

const MODULE_PATHS = ['../lib/config-command', '../lib/config', '../lib/settings'];
const API_KEY = 'secret opaque key';

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

function installAt(scope) {
  const entry = { scope };
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
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

  assert.equal(main(['show'], captured.output), 0);
  assert.match(captured.logs[0], /show_realtime_summary\n  Current: false/);
  assert.match(captured.logs[0], /ingest_url\n  Current: not set/);
  assert.match(captured.logs[0], /\/prism:config help/);
});

test('set and unset persist the boolean value while preserving unrelated config', () => {
  writeJson(configFile(), { apiKey: API_KEY, custom: 'preserve' });
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

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
  const { main } = require('../lib/config-command');

  assert.equal(main([
    'unset', 'ingest_url', '--project-dir', projectDir,
  ], captured.output), 1);
  assert.equal(Object.hasOwn(readJson(configFile()), 'ingest_url'), false);
  assert.deepEqual(readJson(path.join(projectDir, '.claude', 'settings.json')), {});
  assert.equal(readJson(localFile).env.OTEL_LOGS_EXPORTER, 'local-override');
  assert.match(captured.errors[0], /effective OTEL values remain in another settings layer/);
});

test('ingest_url remains persisted when scope or effective projection fails', () => {
  writeJson(configFile(), { apiKey: API_KEY });
  let captured = captureOutput();
  const { main } = require('../lib/config-command');

  assert.equal(main([
    'set', 'ingest_url', 'https://saved-without-scope.example',
    '--project-dir', projectDir,
  ], captured.output), 1);
  assert.equal(readJson(configFile()).ingest_url, 'https://saved-without-scope.example');
  assert.match(captured.errors[0], /Config saved.*install scope is unknown/);

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
  const { main } = require('../lib/config-command');

  assert.equal(main([
    'set', 'ingest_url', 'https://saved-before-read-error.example',
    '--project-dir', projectDir,
  ], captured.output), 1);
  assert.equal(readJson(configFile()).ingest_url, 'https://saved-before-read-error.example');
  assert.match(captured.errors[0], /Unable to read JSON.*installed_plugins\.json/);
  assert.doesNotMatch(captured.errors[0], /install scope is unknown/);
});
