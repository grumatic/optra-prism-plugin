const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, beforeEach, test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const MODULE_PATHS = ['../lib/setup', '../lib/settings', '../lib/config', '../lib/notify'];

let homeDir;
let projectDir;
let originalHome;
let originalEnvKey;

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

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-setup-cli-'));
  projectDir = path.join(homeDir, 'project');
  fs.mkdirSync(projectDir);
  originalHome = process.env.HOME;
  originalEnvKey = process.env.PRISM_API_KEY;
  process.env.HOME = homeDir;
  process.env.PRISM_API_KEY = 'must-not-be-used';
  clearModules();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalEnvKey === undefined) delete process.env.PRISM_API_KEY;
  else process.env.PRISM_API_KEY = originalEnvKey;
  clearModules();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('setup CLI requires one positional opaque KEY and auto-detects scope', async () => {
  const opaqueKey = 'key with spaces and no prefix';
  writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    plugins: {
      'prism@optra-prism': [{
        scope: 'local',
        projectPath: projectDir,
        installPath: ROOT,
      }],
    },
  });

  const config = require('../lib/config');
  let fetchedKey;
  config.fetchConfig = async (apiKey) => {
    fetchedKey = apiKey;
    return { status: 'server', config: { ingest_url: 'https://ingest.example' } };
  };
  const notify = require('../lib/notify');
  let notifiedKey;
  notify.notifySetupComplete = async (apiKey) => {
    notifiedKey = apiKey;
    return { ok: true, httpStatus: 200, error: null };
  };
  delete require.cache[require.resolve('../lib/setup')];

  const captured = captureOutput();
  const { main } = require('../lib/setup');
  assert.equal(await main([
    'apply',
    opaqueKey,
    '--project-dir',
    projectDir,
    '--data-dir',
    path.join(homeDir, 'plugin-data'),
  ], captured.output), 0);
  assert.equal(fetchedKey, opaqueKey);
  assert.equal(notifiedKey, opaqueKey);
  assert.equal(config.readConfig().apiKey, opaqueKey);
  assert.match(captured.logs.join('\n'), /Scope: local/);
  const localSettings = path.join(projectDir, '.claude', 'settings.local.json');
  assert.equal(
    readJson(localSettings).otelHeadersHelper,
    path.join(homeDir, 'plugin-data', 'bin', 'prism-otel-headers-helper.js'),
  );
  assert.equal(
    fs.readFileSync(path.join(homeDir, 'plugin-data', 'last-version.txt'), 'utf8'),
    require('../lib/plugin-update').readCurrentPluginVersion(),
  );
});

test('setup CLI does not fall back to env or accept legacy scope flags', async () => {
  const { APPLY_USAGE, main, parseApplyArgs } = require('../lib/setup');
  assert.deepEqual(parseApplyArgs([]), { projectDir: null, dataDir: null });
  assert.deepEqual(parseApplyArgs(['--project-dir', projectDir]), {
    projectDir,
    dataDir: null,
  });
  assert.deepEqual(parseApplyArgs([
    '--data-dir', path.join(homeDir, 'data'),
    '--project-dir', projectDir,
  ]), {
    projectDir,
    dataDir: path.join(homeDir, 'data'),
  });
  assert.equal(parseApplyArgs(['--scope', 'user']), null);
  assert.equal(parseApplyArgs(['--project-dir']), null);
  assert.equal(parseApplyArgs(['--data-dir', '/one', '--data-dir', '/two']), null);

  for (const argv of [
    ['apply'],
    ['apply', 'key', '--scope', 'user'],
    ['apply', 'key', '--project-dir'],
    ['apply', 'key', '--data-dir'],
    ['apply', 'key', 'extra'],
  ]) {
    const captured = captureOutput();
    assert.equal(await main(argv, captured.output), 2, argv.join(' '));
    assert.deepEqual(captured.errors, [APPLY_USAGE]);
  }
  assert.equal(fs.existsSync(path.join(homeDir, '.prism')), false);
});

test('shell installer delegates an opaque key to the installed setup entrypoint', () => {
  const binDir = path.join(homeDir, 'bin');
  const fakeSetup = path.join(homeDir, 'fake-setup.js');
  const setupCall = path.join(homeDir, 'setup-call.json');
  const opaqueKey = 'opaque installer key';
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(fakeSetup, [
    "const fs = require('fs');",
    'fs.writeFileSync(process.env.SETUP_CALL, JSON.stringify(process.argv.slice(2)));',
    '',
  ].join('\n'));

  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude, [
    '#!/bin/sh',
    'if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then',
    '  target="$HOME/.claude/plugins/cache/optra-prism/prism/0.6.1/lib"',
    '  mkdir -p "$target"',
    '  cp "$FAKE_SETUP_SOURCE" "$target/setup.js"',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(claude, 0o755);

  const result = spawnSync('bash', [path.join(__dirname, '..', 'install.sh'), opaqueKey], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_SETUP_SOURCE: fakeSetup,
      SETUP_CALL: setupCall,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(setupCall, 'utf8')), [
    'apply',
    opaqueKey,
    '--data-dir',
    path.join(homeDir, '.claude', 'plugins', 'data', 'prism-optra-prism'),
  ]);
  assert.match(result.stdout, /Prism configured/);
  assert.doesNotMatch(result.stdout, /invalid.*key|config-cache|scope repair/i);
});

test('shell marketplace reinstall preserves durable plugin data when install and setup are deferred', () => {
  const binDir = path.join(homeDir, 'bin');
  const dataDir = path.join(
    homeDir,
    '.claude',
    'plugins',
    'data',
    'prism-optra-prism',
  );
  const helperPath = path.join(dataDir, 'bin', 'prism-otel-headers-helper.js');
  const cacheDir = path.join(homeDir, '.claude', 'plugins', 'cache', 'optra-prism');
  const installedPlugins = path.join(
    homeDir,
    '.claude',
    'plugins',
    'installed_plugins.json',
  );
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(helperPath, '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '0.7.0\n');
  fs.writeFileSync(path.join(dataDir, 'update-check.json'), '{"checkedAt":1}\n');
  fs.mkdirSync(path.join(cacheDir, 'prism', '0.7.0'), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'prism', '0.7.0', 'stale'), 'remove\n');
  writeJson(installedPlugins, {
    plugins: {
      'prism@optra-prism': [{
        scope: 'local',
        projectPath: projectDir,
        installPath: path.join(cacheDir, 'prism', '0.7.0'),
      }],
      'other@example': [{ scope: 'user' }],
    },
  });
  writeJson(path.join(homeDir, '.claude', 'settings.json'), {
    otelHeadersHelper: helperPath,
  });

  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude, [
    '#!/bin/sh',
    'if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(claude, 0o755);

  const result = spawnSync('bash', [path.join(__dirname, '..', 'install.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin install deferred/);
  assert.match(result.stdout, /No API key provided/);
  assert.equal(fs.readFileSync(helperPath, 'utf8'), '#!/usr/bin/env node\n');
  assert.equal(fs.readFileSync(path.join(dataDir, 'last-version.txt'), 'utf8'), '0.7.0\n');
  assert.equal(
    fs.readFileSync(path.join(dataDir, 'update-check.json'), 'utf8'),
    '{"checkedAt":1}\n',
  );
  assert.equal(readJson(path.join(homeDir, '.claude', 'settings.json')).otelHeadersHelper, helperPath);
  assert.equal(fs.existsSync(cacheDir), false);
  assert.deepEqual(readJson(installedPlugins).plugins, {
    'other@example': [{ scope: 'user' }],
  });
});
