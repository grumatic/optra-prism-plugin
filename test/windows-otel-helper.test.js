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
const { posixOnly } = require('./helpers/platform');

pinClaudeHostVersion(LEGACY_HOST_VERSION);

const API_KEY = 'opaque settings key';
const MODULE_PATHS = ['../lib/config', '../lib/settings', '../lib/status', '../lib/uninstall'];
const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

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
  for (const modulePath of MODULE_PATHS) {
    try { delete require.cache[require.resolve(modulePath)]; } catch {}
  }
}

function simulateWin32() {
  Object.defineProperty(process, 'platform', { ...PLATFORM, value: 'win32' });
}

function restorePlatform() {
  Object.defineProperty(process, 'platform', PLATFORM);
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-win-helper-test-'));
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
  restorePlatform();
  for (const [key, original] of originalEnv) {
    if (original.present) process.env[key] = original.value;
    else delete process.env[key];
  }
  clearModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('win32 install and inspection pass without the 0700 mode', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');

  settings.installOtelHeadersHelper(dataDir);
  const helperPath = settings.helperPathForDataDir(dataDir);
  fs.chmodSync(helperPath, 0o755);

  const inspected = settings.inspectManagedOtelHeadersHelper(dataDir);
  assert.equal(inspected.exactMode, null);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.reason, null);
});

test('win32 inspection still rejects a helper that differs from the bundled source', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');

  settings.installOtelHeadersHelper(dataDir);
  fs.appendFileSync(settings.helperPathForDataDir(dataDir), '\n// tampered\n');

  const inspected = settings.inspectManagedOtelHeadersHelper(dataDir);
  assert.equal(inspected.ok, false);
  assert.equal(inspected.reason, 'managed helper differs from bundled source');
});

test('POSIX inspection still requires mode 0700', posixOnly('POSIX file modes do not exist on native Windows'), () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');

  settings.installOtelHeadersHelper(dataDir);
  fs.chmodSync(settings.helperPathForDataDir(dataDir), 0o755);

  const inspected = settings.inspectManagedOtelHeadersHelper(dataDir);
  assert.equal(inspected.exactMode, false);
  assert.equal(inspected.ok, false);
  assert.equal(inspected.reason, 'managed helper mode is not 0700');
});

test('win32 sync writes the node command form and a second sync is a no-op', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin data');
  const projectFile = settings.pathForScope('project', projectDir);

  assert.equal(settings.syncOtelSettings({ scope: 'project', projectDir, dataDir }), true);
  const helperPath = settings.helperPathForDataDir(dataDir);
  const expected = `node "${helperPath.replace(/\\/g, '/')}"`;
  assert.equal(readJson(projectFile).otelHeadersHelper, expected);
  assert.equal(settings.helperSettingValueForPath(helperPath), expected);

  const before = fs.readFileSync(projectFile, 'utf8');
  const second = settings.syncOtelSettings({
    scope: 'project',
    projectDir,
    dataDir,
    pluginVersion: undefined,
  });
  assert.ok(second);
  assert.equal(fs.readFileSync(projectFile, 'utf8'), before);
  assert.deepEqual(settings.checkOtelSettings({ projectDir, dataDir }), {
    ok: true,
    mismatches: [],
    assistantResponseConflict: null,
  });
});

test('win32 value matching ignores case and slash direction only', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const helperPath = path.join(homeDir, 'Plugin-Data', 'bin', 'prism-otel-headers-helper.js');

  assert.equal(settings.helperSettingValueMatches(
    `NODE "${helperPath.replace(/\//g, '\\').toUpperCase()}"`,
    helperPath,
  ), true);
  assert.equal(settings.helperSettingValueMatches(helperPath, helperPath), false);
  assert.equal(settings.helperSettingValueMatches(undefined, helperPath), false);
  assert.equal(settings.helperSettingValueMatches(
    `node "${helperPath}" --extra`,
    helperPath,
  ), false);
});

test('POSIX value matching stays an exact string comparison', posixOnly('asserts the POSIX bare-path setting value, which native Windows replaces with the node command form'), () => {
  const settings = require('../lib/settings');
  const helperPath = path.join(homeDir, 'plugin-data', 'bin', 'prism-otel-headers-helper.js');

  assert.equal(settings.helperSettingValueForPath(helperPath), helperPath);
  assert.equal(settings.helperSettingValueMatches(helperPath, helperPath), true);
  assert.equal(settings.helperSettingValueMatches(helperPath.toUpperCase(), helperPath), false);
});

test('win32 sync preserves an unrelated headers helper', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const projectFile = settings.pathForScope('project', projectDir);
  writeJson(projectFile, { otelHeadersHelper: 'node "C:/corp/headers.js"' });

  assert.equal(settings.syncOtelSettings({ scope: 'project', projectDir, dataDir }), true);

  assert.equal(readJson(projectFile).otelHeadersHelper, 'node "C:/corp/headers.js"');
  assert.equal(fs.existsSync(settings.helperPathForDataDir(dataDir)), false);
  assert.equal(settings.checkOtelSettings({ projectDir, dataDir }).mismatches.includes(
    settings.OTEL_HEADERS_HELPER_KEY,
  ), true);
});

test('win32 removeOtelSettings removes the command form and keeps a non-matching value', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const projectFile = settings.pathForScope('project', projectDir);
  const localFile = settings.pathForScope('local', projectDir);
  const helperPath = settings.helperPathForDataDir(dataDir);
  writeJson(projectFile, { otelHeadersHelper: settings.helperSettingValueForPath(helperPath) });
  writeJson(localFile, { otelHeadersHelper: 'node "C:/corp/headers.js"' });

  settings.removeOtelSettings({ scope: 'all', projectDir, dataDir });

  assert.equal(Object.hasOwn(readJson(projectFile), 'otelHeadersHelper'), false);
  assert.equal(readJson(localFile).otelHeadersHelper, 'node "C:/corp/headers.js"');
});

test('win32 uninstall selection removes the command form and unwraps a preserved one', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const { selectOtelHeadersHelper } = require('../lib/uninstall');
  const pluginDataDir = path.join(homeDir, 'plugin-data');
  const expectedPath = settings.helperPathForDataDir(pluginDataDir);

  const exact = selectOtelHeadersHelper({
    expectedPath,
    pluginDataDir,
    settings: { otelHeadersHelper: settings.helperSettingValueForPath(expectedPath) },
  });
  assert.equal(exact.decision, 'remove');
  assert.equal(exact.reason, 'exact-path-match');

  const inside = selectOtelHeadersHelper({
    expectedPath,
    pluginDataDir,
    settings: { otelHeadersHelper: `node "${path.join(pluginDataDir, 'bin', 'other.js')}"` },
  });
  assert.equal(inside.decision, 'preserve');
  assert.equal(inside.reason, 'value-mismatch');
  assert.equal(inside.referencesPluginData, true);

  const outside = selectOtelHeadersHelper({
    expectedPath,
    pluginDataDir,
    settings: { otelHeadersHelper: 'node "C:/corp/headers.js"' },
  });
  assert.equal(outside.decision, 'preserve');
  assert.equal(outside.referencesPluginData, false);
});

test('win32 status artifact renders the mode as n/a and the helper as healthy', () => {
  simulateWin32();
  const settings = require('../lib/settings');
  const status = require('../lib/status');
  const dataDir = path.join(homeDir, 'plugin-data');

  assert.equal(settings.syncOtelSettings({ scope: 'project', projectDir, dataDir }), true);
  const diagnostic = status.inspectOtelHeadersHelper({ projectDir, dataDir });

  assert.match(status.formatArtifact(diagnostic), /exact mode 0700=n\/a/);
  assert.equal(diagnostic.ok, true);
  assert.equal(status.helperConfiguredMatchesExpected(diagnostic), true);
  assert.equal(status.helperHasEffectiveConflict(diagnostic), false);
  assert.match(status.helperExpectedValue(diagnostic), /^node "/);
});

test('win32 doctor reports the helper as passing with the mode not applicable', () => {
  simulateWin32();
  MODULE_PATHS.push('../lib/doctor');
  clearModules();
  const settings = require('../lib/settings');
  const doctor = require('../lib/doctor');
  const dataDir = path.join(homeDir, 'plugin-data');

  assert.equal(settings.syncOtelSettings({ scope: 'project', projectDir, dataDir }), true);
  const check = doctor.checkOtelHeadersHelper(projectDir, dataDir);

  assert.equal(check.status, 'pass');
  assert.match(check.message, /exact mode 0700=n\/a/);
  assert.match(check.message, /expected: node "/);
  assert.equal(check.remediation, null);
});

test('POSIX status artifact keeps the exact mode label', posixOnly('asserts the POSIX mode label and bare-path value, which native Windows renders as n/a and the node command form'), () => {
  const settings = require('../lib/settings');
  const status = require('../lib/status');
  const dataDir = path.join(homeDir, 'plugin-data');

  assert.equal(settings.syncOtelSettings({ scope: 'project', projectDir, dataDir }), true);
  const diagnostic = status.inspectOtelHeadersHelper({ projectDir, dataDir });

  assert.match(status.formatArtifact(diagnostic), /exact mode 0700=yes/);
  assert.equal(status.helperExpectedValue(diagnostic), settings.helperPathForDataDir(dataDir));
});
