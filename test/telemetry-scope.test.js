const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const hostTelemetry = require('../lib/host-telemetry');

const ROOT = path.resolve(__dirname, '..');
const API_KEY = 'opaque scope key';
const INGEST_URL = 'http://127.0.0.1:1';
const CURRENT_HOST = '2.1.283';
const LEGACY_HOST = '2.1.281';
const MODULE_PATHS = [
  '../lib/config',
  '../lib/doctor',
  '../lib/notify',
  '../lib/plugin-activation',
  '../lib/settings',
  '../lib/setup',
  '../lib/status',
];

let homeDir;
let projectDir;
let dataDir;
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

function installAt(scope) {
  const entry = { scope, installPath: ROOT };
  if (scope !== 'user') entry.projectPath = projectDir;
  writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [entry] },
  });
}

function userFile() {
  return path.join(homeDir, '.claude', 'settings.json');
}

function localFile() {
  return path.join(projectDir, '.claude', 'settings.local.json');
}

function captureOutput() {
  const logs = [];
  const errors = [];
  return {
    output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
    logs,
    errors,
  };
}

function serverConfig() {
  return async () => ({ status: 'server', config: { ingest_url: INGEST_URL } });
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-telemetry-scope-'));
  projectDir = path.join(homeDir, 'project');
  dataDir = path.join(homeDir, 'plugin-data');
  fs.mkdirSync(projectDir);
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  writeJson(path.join(homeDir, '.prism', 'config.json'), { apiKey: API_KEY, ingest_url: INGEST_URL });
  clearModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  clearModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('host version resolves from the executing Claude Code binary, then PATH', () => {
  const calls = [];
  const version = hostTelemetry.resolveHostVersion({
    env: { CLAUDE_CODE_EXECPATH: '/opt/claude/versions/9.9.9' },
    execFileSyncFn: (command) => {
      calls.push(command);
      if (command === 'claude') return '2.1.283 (Claude Code)\n';
      throw new Error('not executable');
    },
  });
  assert.equal(version, '2.1.283');
  assert.deepEqual(calls, ['/opt/claude/versions/9.9.9', 'claude']);

  assert.equal(hostTelemetry.resolveHostVersion({
    env: { CLAUDE_CODE_EXECPATH: 'relative/claude' },
    execFileSyncFn: () => 'not a version',
  }), null);
});

test('only an older known host lets project and local scopes enable telemetry', () => {
  assert.equal(hostTelemetry.hostIgnoresProjectTelemetry('2.1.281'), false);
  assert.equal(hostTelemetry.hostIgnoresProjectTelemetry('2.1.282'), true);
  assert.equal(hostTelemetry.hostIgnoresProjectTelemetry(null), true);

  for (const scope of ['project', 'local']) {
    assert.equal(hostTelemetry.scopeCanEnableTelemetry(scope, LEGACY_HOST), true);
    assert.equal(hostTelemetry.scopeCanEnableTelemetry(scope, CURRENT_HOST), false);
    assert.equal(hostTelemetry.scopeCanEnableTelemetry(scope, null), false);
  }
  assert.equal(hostTelemetry.scopeCanEnableTelemetry('user', CURRENT_HOST), true);
  assert.equal(hostTelemetry.scopeCanEnableTelemetry(null, LEGACY_HOST), false);
});

test('project and local settings keep only values that turn telemetry off', () => {
  const applies = hostTelemetry.appliesFromProjectSettings;
  assert.equal(applies('CLAUDE_CODE_ENABLE_TELEMETRY', '1'), false);
  assert.equal(applies('OTEL_LOGS_EXPORTER', 'otlp'), false);
  assert.equal(applies('OTEL_LOGS_EXPORTER', 'none'), true);
  assert.equal(applies('OTEL_LOG_USER_PROMPTS', '1'), false);
  assert.equal(applies('OTEL_LOG_USER_PROMPTS', '0'), true);
  assert.equal(applies('OTEL_LOG_ASSISTANT_RESPONSES', '0'), false);
  assert.equal(applies('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'https://x/v1/logs'), false);
  assert.equal(applies('OTEL_EXPORTER_OTLP_HEADERS', 'x-api-key=k'), false);
  assert.equal(applies('otel_exporter_otlp_protocol', 'http/json'), false);
  assert.equal(applies('OTEL_EXPORTER_OTLP_TIMEOUT', '1000'), true);
  assert.equal(applies('OTEL_METRIC_EXPORT_INTERVAL', '10000'), true);
  assert.equal(applies('OTEL_BLRP_SCHEDULE_DELAY', '1000'), true);
});

test('session telemetry is observable only inside a Claude Code subprocess', () => {
  assert.deepEqual(hostTelemetry.readSessionTelemetry({}), { observable: false, enabled: null });
  assert.deepEqual(hostTelemetry.readSessionTelemetry({ CLAUDECODE: '1' }), { observable: true, enabled: false });
  assert.deepEqual(
    hostTelemetry.readSessionTelemetry({ CLAUDECODE: '1', CLAUDE_CODE_ENABLE_TELEMETRY: 'true' }),
    { observable: true, enabled: true },
  );
});

test('local sync on a current host withdraws only Prism-owned values', () => {
  installAt('local');
  const settings = require('../lib/settings');
  const expected = settings.buildExpectedOtelEnv();
  const helperPath = settings.helperPathForDataDir(dataDir);
  writeJson(localFile(), {
    otelHeadersHelper: helperPath,
    env: {
      ...expected.otelEnv,
      OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${encodeURIComponent(API_KEY)},x-prism-plugin-version=0.1.0`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://someone-else.example/v1/logs',
      UNRELATED: 'keep',
    },
  });

  assert.equal(settings.syncOtelSettings({ projectDir, dataDir, hostVersion: CURRENT_HOST }), true);
  assert.deepEqual(readJson(localFile()), {
    env: {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://someone-else.example/v1/logs',
      UNRELATED: 'keep',
    },
  });
  assert.equal(fs.existsSync(dataDir), false);

  const status = settings.checkOtelSettings({ projectDir, dataDir, hostVersion: CURRENT_HOST });
  assert.equal(status.telemetryWithheld, true);
  assert.equal(status.installScope, 'local');
  assert.equal(status.hostVersion, CURRENT_HOST);
});

test('local sync on an older host still projects into the local scope', () => {
  installAt('local');
  const settings = require('../lib/settings');
  assert.equal(settings.syncOtelSettings({ projectDir, hostVersion: LEGACY_HOST }), true);
  assert.equal(readJson(localFile()).env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.deepEqual(settings.checkOtelSettings({ projectDir, hostVersion: LEGACY_HOST }).mismatches, []);
});

test('a user install is judged without project telemetry values the host ignores', () => {
  installAt('user');
  const settings = require('../lib/settings');
  assert.equal(settings.syncOtelSettings({ projectDir, hostVersion: CURRENT_HOST }), true);
  writeJson(localFile(), {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '0',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://stale.example/v1/logs',
    },
  });
  assert.equal(settings.checkOtelSettings({ projectDir, hostVersion: CURRENT_HOST }).ok, true);
  assert.deepEqual(
    settings.checkOtelSettings({ projectDir, hostVersion: LEGACY_HOST }).mismatches,
    ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'],
  );

  writeJson(localFile(), { env: { OTEL_LOGS_EXPORTER: 'none' } });
  assert.deepEqual(
    settings.checkOtelSettings({ projectDir, hostVersion: CURRENT_HOST }).mismatches,
    ['OTEL_LOGS_EXPORTER'],
  );
});

test('version activation withholds local metadata and writes the user opt-out file', () => {
  const settings = require('../lib/settings');
  installAt('local');
  const expected = settings.buildExpectedOtelEnv();
  writeJson(localFile(), { env: { ...expected.otelEnv } });
  const withheld = settings.syncPluginVersionMetadata({
    projectDir,
    dataDir,
    pluginVersion: '1.2.3',
    hostVersion: CURRENT_HOST,
  });
  assert.equal(withheld.ok, true);
  assert.equal(withheld.telemetryWithheld, true);
  assert.equal(withheld.changed, true);
  assert.equal(fs.existsSync(localFile()), true);
  assert.deepEqual(readJson(localFile()), {});
  assert.equal(fs.existsSync(settings.optOutSettingsPath(dataDir)), false);

  installAt('user');
  const projected = settings.syncPluginVersionMetadata({
    projectDir,
    dataDir,
    pluginVersion: '1.2.3',
    hostVersion: CURRENT_HOST,
  });
  assert.equal(projected.ok, true);
  assert.equal(projected.telemetryWithheld, false);
  const optOutFile = settings.optOutSettingsPath(dataDir);
  assert.equal(projected.optOutSettingsFile, optOutFile);
  assert.deepEqual(readJson(optOutFile), settings.buildOptOutSettings());
  assert.equal(fs.statSync(optOutFile).mode & 0o777, 0o600);
  assert.deepEqual(readJson(optOutFile).enabledPlugins, { 'prism@optra-prism': false });
  assert.equal(settings.writeOptOutSettings(dataDir).changed, false);
});

test('the opt-out file refuses a symlinked target', () => {
  const settings = require('../lib/settings');
  fs.mkdirSync(dataDir, { recursive: true });
  const outside = path.join(homeDir, 'outside.json');
  fs.writeFileSync(outside, '{}\n');
  fs.symlinkSync(outside, settings.optOutSettingsPath(dataDir));
  assert.throws(() => settings.writeOptOutSettings(dataDir), /not a symlink/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{}\n');
});

test('setup at local scope on a current host reports that telemetry is not collected', async () => {
  installAt('local');
  const captured = captureOutput();
  const { applySetup } = require('../lib/setup');
  const exitCode = await applySetup({
    apiKey: API_KEY,
    projectDir,
    dataDir,
    output: captured.output,
    fetchConfigFn: serverConfig(),
    notifyDashboardFn: async () => ({ ok: true, httpStatus: 200, error: null }),
    hostVersion: CURRENT_HOST,
  });

  assert.equal(exitCode, 0, captured.errors.join('\n'));
  const log = captured.logs.join('\n');
  assert.match(log, /Scope: local/);
  assert.match(log, /Telemetry: NOT collected in this project\./);
  assert.match(log, /Claude Code 2\.1\.283 ignores telemetry variables in local settings/);
  assert.match(log, /claude plugin uninstall prism@optra-prism --scope local/);
  assert.match(log, /claude plugin install prism@optra-prism --scope user/);
  assert.doesNotMatch(log, /Restart Claude Code to activate telemetry/);
  assert.doesNotMatch(log, /claude --settings/);
  assert.equal(fs.existsSync(localFile()), false);
});

test('setup at user scope writes the opt-out file and prints how to use it', async () => {
  installAt('user');
  const captured = captureOutput();
  const { applySetup } = require('../lib/setup');
  const exitCode = await applySetup({
    apiKey: API_KEY,
    projectDir,
    dataDir,
    output: captured.output,
    fetchConfigFn: serverConfig(),
    notifyDashboardFn: async () => ({ ok: true, httpStatus: 200, error: null }),
    hostVersion: CURRENT_HOST,
  });

  assert.equal(exitCode, 0, captured.errors.join('\n'));
  const optOutFile = path.join(dataDir, 'prism-off.settings.json');
  const log = captured.logs.join('\n');
  assert.match(log, /Restart Claude Code to activate telemetry\./);
  assert.ok(log.includes(`To run a session without Prism: claude --settings ${optOutFile}`));
  assert.equal(readJson(userFile()).env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(fs.existsSync(optOutFile), true);
});

test('SessionStart warns about withheld telemetry only when a process starts without it', async () => {
  const { collectPluginNotices } = require('../lib/plugin-activation');
  const activateFn = () => ({
    notice: null,
    telemetryWithheld: true,
    scope: 'local',
    hostVersion: CURRENT_HOST,
  });
  const checkUpdateFn = async () => ({ updateAvailable: false });

  const startup = await collectPluginNotices({ source: 'startup', activateFn, checkUpdateFn, env: {} });
  assert.equal(startup.notices.length, 1);
  assert.match(startup.notices[0], /installed at local scope, where Claude Code 2\.1\.283 ignores telemetry settings/);

  const resume = await collectPluginNotices({ source: 'resume', activateFn, checkUpdateFn, env: {} });
  assert.equal(resume.notices.length, 1);

  const clear = await collectPluginNotices({ source: 'clear', activateFn, checkUpdateFn, env: {} });
  assert.deepEqual(clear.notices, []);

  const exported = await collectPluginNotices({
    source: 'startup',
    activateFn,
    checkUpdateFn,
    env: { CLAUDECODE: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
  });
  assert.deepEqual(exported.notices, []);
});

test('a withheld activation never asks for a restart for telemetry metadata', () => {
  const { activatePluginVersion } = require('../lib/plugin-activation');
  const activation = activatePluginVersion({
    readCurrentVersionFn: () => '1.2.4',
    readActiveVersionFn: () => '1.2.3',
    writeActiveVersionFn: () => true,
    syncMetadataFn: () => ({ ok: true, changed: true, telemetryWithheld: true, scope: 'local', hostVersion: null }),
  });
  assert.equal(activation.versionChanged, true);
  assert.equal(activation.telemetryWithheld, true);
  assert.equal(activation.scope, 'local');
  assert.equal(activation.notice, null);
});

test('doctor fails a withheld local install and skips its helper check', async () => {
  installAt('local');
  const { runChecks } = require('../lib/doctor');
  const result = await runChecks({ projectDir, dataDir, env: {}, hostVersion: CURRENT_HOST });
  const otel = result.checks.find((check) => check.id === 'otel-settings');
  const helper = result.checks.find((check) => check.id === 'otel-headers-helper');
  assert.equal(otel.status, 'fail');
  assert.match(otel.message, /ignores telemetry variables in local settings/);
  assert.match(otel.remediation, /claude plugin install prism@optra-prism --scope user/);
  assert.equal(helper.status, 'skip');
  assert.equal(result.summary.skipped, 1);

  const exported = await runChecks({
    projectDir,
    dataDir,
    env: { CLAUDECODE: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
    hostVersion: CURRENT_HOST,
  });
  assert.equal(exported.checks.find((check) => check.id === 'otel-settings').status, 'warn');
});

test('doctor judges a user install by the session telemetry switch', async () => {
  installAt('user');
  const settings = require('../lib/settings');
  assert.equal(settings.syncOtelSettings({ projectDir, dataDir, hostVersion: CURRENT_HOST }), true);
  const { runChecks } = require('../lib/doctor');
  const statusFor = async (env) => (await runChecks({ projectDir, dataDir, env, hostVersion: CURRENT_HOST }))
    .checks.find((check) => check.id === 'otel-settings');

  const on = await statusFor({ CLAUDECODE: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
  assert.equal(on.status, 'pass');
  assert.match(on.message, /telemetry is on in this session/);

  const restart = await statusFor({ CLAUDECODE: '1' });
  assert.equal(restart.status, 'warn');
  assert.equal(restart.remediation, 'Restart Claude Code to activate telemetry');

  const outside = await statusFor({});
  assert.equal(outside.status, 'warn');
  assert.match(outside.message, /not observable outside Claude Code/);
});

test('status renders withheld telemetry without endpoint or helper claims', () => {
  const { renderStatus } = require('../lib/status');
  const output = renderStatus({
    config: { apiKey: API_KEY, ingest_url: INGEST_URL, show_realtime_summary: false },
    rawConfig: { apiKey: API_KEY, ingest_url: INGEST_URL },
    installScope: 'local',
    effectiveSettings: { env: {}, sources: {}, files: {} },
    expectedOtel: null,
    otelStatus: {
      ok: false,
      mismatches: [],
      telemetryWithheld: true,
      installScope: 'local',
      hostVersion: CURRENT_HOST,
    },
    health: { ok: false, reachable: false, httpStatus: null, error: 'refused' },
    hostVersion: CURRENT_HOST,
    sessionTelemetry: { observable: true, enabled: false },
  });
  assert.match(output, /\*\*Claude Code:\*\* 2\.1\.283/);
  assert.match(output, /\*\*Telemetry:\*\* not collected in this project\./);
  assert.match(output, /claude plugin install prism@optra-prism --scope user/);
  assert.doesNotMatch(output, /Effective OTEL Logs|OTEL Headers Helper|OTEL settings:/);
  assert.match(output, /Ingest health endpoint:\*\* unreachable \(refused\)/);
});

test('status reports the session switch and the opt-out file for a user install', () => {
  const { renderStatus } = require('../lib/status');
  const output = renderStatus({
    config: { apiKey: API_KEY, ingest_url: INGEST_URL, show_realtime_summary: false },
    rawConfig: { apiKey: API_KEY, ingest_url: INGEST_URL },
    installScope: 'user',
    effectiveSettings: { env: {}, sources: {}, files: {} },
    expectedOtel: null,
    otelStatus: { ok: true, mismatches: [] },
    health: { ok: true, reachable: true, httpStatus: 200 },
    hostVersion: CURRENT_HOST,
    sessionTelemetry: { observable: true, enabled: false },
    optOutFile: '/data/prism-off.settings.json',
  });
  assert.match(output, /\*\*Session telemetry:\*\* off in this session\. Restart Claude Code to activate telemetry\./);
  assert.match(output, /\*\*Run without Prism:\*\* `claude --settings \/data\/prism-off\.settings\.json`/);
});
