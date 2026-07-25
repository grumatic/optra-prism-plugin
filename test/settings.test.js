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

test('scope detection can bind the registry entry to the current plugin root', () => {
  const settings = require('../lib/settings');
  const currentRoot = path.join(homeDir, 'current-plugin');
  const otherRoot = path.join(homeDir, 'other-plugin');
  fs.mkdirSync(currentRoot);
  fs.mkdirSync(otherRoot);
  writeJson(settings.INSTALLED_PLUGINS, { plugins: { [settings.PLUGIN_ID]: [
    { scope: 'local', projectPath: projectDir, installPath: otherRoot },
    { scope: 'project', projectPath: projectDir, installPath: currentRoot },
  ] } });

  assert.equal(settings.detectInstallScope(projectDir), 'local');
  assert.equal(settings.detectInstallScope(projectDir, currentRoot), 'project');
  assert.equal(settings.detectInstallScope(projectDir, path.join(homeDir, 'missing-root')), null);
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

test('sync installs a stable executable helper in plugin data and projects its exact path', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin data');
  const projectFile = settings.pathForScope('project', projectDir);

  assert.equal(settings.syncOtelSettings({
    scope: 'project',
    projectDir,
    dataDir,
  }), true);

  const helperPath = settings.helperPathForDataDir(dataDir);
  assert.equal(readJson(projectFile).otelHeadersHelper, helperPath);
  assert.equal(fs.existsSync(helperPath), true);
  assert.equal(fs.statSync(helperPath).mode & 0o777, 0o700);
  assert.deepEqual(settings.checkOtelSettings({ projectDir, dataDir }), {
    ok: true,
    mismatches: [],
  });
});

test('sync preserves an unrelated headers helper and reports the effective conflict', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const projectFile = settings.pathForScope('project', projectDir);
  writeJson(projectFile, {
    otelHeadersHelper: '/usr/local/bin/company-otel-headers',
    unrelated: 'preserve',
  });

  assert.equal(settings.syncOtelSettings({
    scope: 'project',
    projectDir,
    dataDir,
  }), true);

  const projected = readJson(projectFile);
  assert.equal(projected.otelHeadersHelper, '/usr/local/bin/company-otel-headers');
  assert.equal(projected.unrelated, 'preserve');
  assert.equal(fs.existsSync(settings.helperPathForDataDir(dataDir)), false);
  assert.equal(settings.checkOtelSettings({ projectDir, dataDir }).mismatches.includes(
    settings.OTEL_HEADERS_HELPER_KEY,
  ), true);
});

test('sync preserves an unrelated helper that is effective from another scope', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const userFile = settings.pathForScope('user', projectDir);
  const projectFile = settings.pathForScope('project', projectDir);
  writeJson(userFile, {
    otelHeadersHelper: '/usr/local/bin/company-otel-headers',
  });

  assert.equal(settings.syncOtelSettings({
    scope: 'project',
    projectDir,
    dataDir,
  }), true);

  assert.equal(Object.hasOwn(readJson(projectFile), 'otelHeadersHelper'), false);
  assert.equal(
    settings.readEffectiveSetting(settings.OTEL_HEADERS_HELPER_KEY, projectDir).value,
    '/usr/local/bin/company-otel-headers',
  );
  assert.equal(fs.existsSync(settings.helperPathForDataDir(dataDir)), false);
});

test('targeted sync keeps static metadata valid while preserving a cross-scope helper', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const projectFile = settings.pathForScope('project', projectDir);
  const localFile = settings.pathForScope('local', projectDir);
  writeJson(localFile, {
    otelHeadersHelper: '/usr/local/bin/company-otel-headers',
  });

  const result = settings.syncPluginVersionMetadata({
    scope: 'project',
    projectDir,
    dataDir,
    pluginVersion: '1.2.3',
  });

  assert.equal(result.ok, true);
  assert.equal(result.helperConfigured, false);
  assert.equal(result.helperConflict, true);
  assert.deepEqual(result.effectiveHelper, {
    value: '/usr/local/bin/company-otel-headers',
    source: 'local',
    configured: false,
  });
  assert.equal(Object.hasOwn(readJson(projectFile), 'otelHeadersHelper'), false);
  assert.equal(readJson(localFile).otelHeadersHelper, '/usr/local/bin/company-otel-headers');
  assert.equal(fs.existsSync(settings.helperPathForDataDir(dataDir)), false);
});

test('helper installation rejects a pre-existing symlink target', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const helperPath = settings.helperPathForDataDir(dataDir);
  const outside = path.join(homeDir, 'outside-helper');
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(outside, 'preserve');
  fs.symlinkSync(outside, helperPath);

  assert.throws(
    () => settings.syncOtelSettings({ scope: 'project', projectDir, dataDir }),
    /regular file/,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  assert.equal(fs.lstatSync(helperPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(settings.pathForScope('project', projectDir)), false);
});

test('helper installation rejects symlinked data and bin directories', () => {
  const settings = require('../lib/settings');
  const outsideData = path.join(homeDir, 'outside-data');
  const symlinkedData = path.join(homeDir, 'symlinked-data');
  fs.mkdirSync(outsideData);
  fs.symlinkSync(outsideData, symlinkedData);

  assert.throws(
    () => settings.syncOtelSettings({
      scope: 'project',
      projectDir,
      dataDir: symlinkedData,
    }),
    /CLAUDE_PLUGIN_DATA must be a non-symlink directory/,
  );
  assert.equal(fs.existsSync(path.join(outsideData, 'bin')), false);

  const dataDir = path.join(homeDir, 'plugin-data');
  const outsideBin = path.join(homeDir, 'outside-bin');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(outsideBin);
  fs.symlinkSync(outsideBin, path.join(dataDir, 'bin'));

  assert.throws(
    () => settings.syncOtelSettings({
      scope: 'project',
      projectDir,
      dataDir,
    }),
    /helper bin must be a non-symlink directory/,
  );
  assert.equal(fs.existsSync(path.join(outsideBin, settings.OTEL_HEADERS_HELPER_FILENAME)), false);
});

test('managed helper inspector verifies the safe chain, ownership, mode, and exact bytes', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  settings.installOtelHeadersHelper(dataDir);

  assert.deepEqual(settings.inspectManagedOtelHeadersHelper(dataDir), {
    expectedPath: settings.helperPathForDataDir(dataDir),
    expectedPathError: null,
    exists: true,
    regularFile: true,
    notSymlink: true,
    safePath: true,
    ownedByCurrentUser: true,
    exactMode: true,
    executable: true,
    matchesBundledSource: true,
    dataDirExists: true,
    dataDirDirectory: true,
    dataDirNotSymlink: true,
    binDirExists: true,
    binDirDirectory: true,
    binDirNotSymlink: true,
    ok: true,
    reason: null,
  });

  const helperPath = settings.helperPathForDataDir(dataDir);
  fs.writeFileSync(helperPath, '#!/usr/bin/env node\nprocess.stdout.write(\"unsafe\")\n');
  fs.chmodSync(helperPath, 0o755);
  const corrupt = settings.inspectManagedOtelHeadersHelper(dataDir);
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.exactMode, false);
  assert.equal(corrupt.matchesBundledSource, false);
  assert.match(corrupt.reason, /mode is not 0700/);
});

test('version activation updates only the static headers and owned helper metadata', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const localFile = settings.pathForScope('local', projectDir);
  writeJson(localFile, {
    permissions: { allow: ['Bash(npm test)'] },
    env: {
      OTEL_LOGS_EXPORTER: 'intentionally-stale',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=old,x-prism-plugin-version=0.1.0',
      UNRELATED: 'preserve',
    },
  });
  fs.chmodSync(localFile, 0o640);

  const result = settings.syncPluginVersionMetadata({
    scope: 'local',
    projectDir,
    dataDir,
    pluginVersion: '1.2.3',
  });

  assert.equal(result.ok, true);
  assert.equal(result.helperConfigured, true);
  const projected = readJson(localFile);
  assert.equal(projected.env.OTEL_LOGS_EXPORTER, 'intentionally-stale');
  assert.equal(projected.env.UNRELATED, 'preserve');
  assert.equal(
    projected.env.OTEL_EXPORTER_OTLP_HEADERS,
    `x-api-key=${encodeURIComponent(API_KEY)},x-prism-plugin-version=1.2.3`,
  );
  assert.equal(projected.otelHeadersHelper, settings.helperPathForDataDir(dataDir));
  assert.deepEqual(projected.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(fs.statSync(localFile).mode & 0o777, 0o640);
});

test('targeted sync fails when a higher-precedence layer overrides projected headers', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const projectFile = settings.pathForScope('project', projectDir);
  const localFile = settings.pathForScope('local', projectDir);
  writeJson(localFile, {
    env: {
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=stale,x-prism-plugin-version=0.1.0',
    },
  });

  const result = settings.syncPluginVersionMetadata({
    scope: 'project',
    projectDir,
    dataDir,
    pluginVersion: '1.2.3',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'effective OTEL headers overridden');
  assert.equal(result.effectiveHeaderSource, 'local');
  assert.equal(
    result.effectiveHeaders,
    'x-api-key=stale,x-prism-plugin-version=0.1.0',
  );
  assert.equal(
    readJson(projectFile).env.OTEL_EXPORTER_OTLP_HEADERS,
    `x-api-key=${encodeURIComponent(API_KEY)},x-prism-plugin-version=1.2.3`,
  );
});

test('settings CAS retries against the latest full-file state and preserves concurrent keys', () => {
  const settings = require('../lib/settings');
  const projectFile = settings.pathForScope('project', projectDir);
  writeJson(projectFile, { unrelated: 'before' });

  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function patchedWriteFileSync(file, ...args) {
    const result = originalWriteFileSync.call(fs, file, ...args);
    if (typeof file === 'string'
      && !injected
      && path.dirname(file) === path.dirname(projectFile)
      && path.basename(file).startsWith(`.${path.basename(projectFile)}.`)
      && path.basename(file).endsWith('.tmp')) {
      injected = true;
      originalWriteFileSync.call(
        fs,
        projectFile,
        `${JSON.stringify({ unrelated: 'before', concurrent: 'preserve' }, null, 2)}\n`,
      );
    }
    return result;
  };

  try {
    assert.equal(settings.syncOtelSettings({
      scope: 'project',
      projectDir,
    }), true);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  const projected = readJson(projectFile);
  assert.equal(injected, true);
  assert.equal(projected.concurrent, 'preserve');
  assert.equal(projected.unrelated, 'before');
  assert.equal(projected.env.OTEL_LOGS_EXPORTER, 'otlp');
});

test('targeted settings CAS fails safely after persistent concurrent changes', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const localFile = settings.pathForScope('local', projectDir);
  writeJson(localFile, {
    env: {
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=old,x-prism-plugin-version=0.1.0',
    },
  });

  const originalWriteFileSync = fs.writeFileSync;
  let conflictCount = 0;
  fs.writeFileSync = function patchedWriteFileSync(file, ...args) {
    const result = originalWriteFileSync.call(fs, file, ...args);
    if (typeof file === 'string'
      && path.dirname(file) === path.dirname(localFile)
      && path.basename(file).startsWith(`.${path.basename(localFile)}.`)
      && path.basename(file).endsWith('.tmp')) {
      conflictCount += 1;
      originalWriteFileSync.call(
        fs,
        localFile,
        `${JSON.stringify({
          concurrent: conflictCount,
          env: {
            OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=old,x-prism-plugin-version=0.1.0',
          },
        }, null, 2)}\n`,
      );
    }
    return result;
  };

  let result;
  try {
    result = settings.syncPluginVersionMetadata({
      scope: 'local',
      projectDir,
      dataDir,
      pluginVersion: '1.2.3',
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(conflictCount, 3);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'settings changed concurrently');
  assert.equal(readJson(localFile).concurrent, 3);
  assert.equal(
    readJson(localFile).env.OTEL_EXPORTER_OTLP_HEADERS,
    'x-api-key=old,x-prism-plugin-version=0.1.0',
  );
});

test('settings projection rejects a symlink target without replacing it or mutating its target', () => {
  const settings = require('../lib/settings');
  const projectFile = settings.pathForScope('project', projectDir);
  const externalFile = path.join(homeDir, 'external-settings.json');
  const externalBefore = {
    env: { UNRELATED: 'preserve' },
    marker: 'external',
  };
  writeJson(externalFile, externalBefore);
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.symlinkSync(externalFile, projectFile);

  assert.equal(settings.syncOtelSettings({
    scope: 'project',
    projectDir,
  }), false);
  assert.equal(fs.lstatSync(projectFile).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(projectFile), externalFile);
  assert.deepEqual(readJson(externalFile), externalBefore);
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

test('explicit removal deletes only the exact Prism-owned helper path', () => {
  const settings = require('../lib/settings');
  const dataDir = path.join(homeDir, 'plugin-data');
  const projectFile = settings.pathForScope('project', projectDir);
  const localFile = settings.pathForScope('local', projectDir);
  writeJson(projectFile, {
    otelHeadersHelper: settings.helperPathForDataDir(dataDir),
    unrelated: 'preserve',
  });
  writeJson(localFile, {
    otelHeadersHelper: '/usr/local/bin/company-otel-headers',
  });

  assert.deepEqual(settings.removeOtelSettings({
    scope: 'all',
    projectDir,
    dataDir,
  }), ['project']);
  assert.deepEqual(readJson(projectFile), { unrelated: 'preserve' });
  assert.deepEqual(readJson(localFile), {
    otelHeadersHelper: '/usr/local/bin/company-otel-headers',
  });
});
