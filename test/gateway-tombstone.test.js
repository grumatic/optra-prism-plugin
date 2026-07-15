const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const API_KEY = 'gck_1234567890abcdef';
const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function withoutIngestOverride(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.PRISM_INGEST_URL;
  return env;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('legacy routing controls do not appear in runtime exports', () => {
  const home = makeTempDir('prism-runtime-');
  writeJson(path.join(home, '.prism', 'config.json'), {
    apiKey: API_KEY,
    enableGateway: true,
  });
  writeJson(path.join(home, '.prism', 'config-cache.json'), {
    ingest_url: 'https://cached-ingest.example',
    gateway_url: 'https://stale-gateway.example',
    anthropic_base_url: 'https://stale-anthropic.example',
    dashboard_url: 'https://cached-dashboard.example',
    key_prefix: API_KEY.substring(0, 12),
    cached_at: new Date().toISOString(),
  });

  const result = spawnSync(process.execPath, ['-e', `
    const runtime = require(${JSON.stringify(path.join(ROOT, 'lib', 'env.js'))});
    process.stdout.write(JSON.stringify(runtime));
  `], {
    encoding: 'utf8',
    env: withoutIngestOverride({
      HOME: home,
      CLAUDE_PLUGIN_OPTION_apiKey: API_KEY,
      CLAUDE_PLUGIN_OPTION_enableGateway: 'true',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(result.stdout);
  assert.equal(runtime.INGEST_URL, 'https://cached-ingest.example');
  assert.equal(Object.hasOwn(runtime, 'ENABLE_GATEWAY'), false);
  assert.equal(Object.hasOwn(runtime, 'GATEWAY_URL'), false);
  assert.equal(JSON.stringify(runtime).includes('stale-gateway'), false);
});

test('session start preserves user Anthropic settings and emits telemetry settings only', () => {
  const home = makeTempDir('prism-session-');
  const dataDir = path.join(home, 'plugin-data');
  const envFile = path.join(home, 'claude-env');
  const userEnv = [
    'export ANTHROPIC_BASE_URL=https://user-proxy.example',
    'export ANTHROPIC_CUSTOM_HEADERS="x-user: keep"',
    '',
  ].join('\n');
  fs.mkdirSync(dataDir, { recursive: true });

  writeJson(path.join(home, '.prism', 'config.json'), {
    apiKey: API_KEY,
    prismThreshold: 6,
    enableGateway: true,
  });
  writeJson(path.join(home, '.prism', 'config-cache.json'), {
    ingest_url: 'https://cached-ingest.example',
    gateway_url: 'https://stale-gateway.example',
    anthropic_base_url: 'https://stale-anthropic.example',
    dashboard_url: 'https://cached-dashboard.example',
    key_prefix: API_KEY.substring(0, 12),
    cached_at: new Date().toISOString(),
  });
  fs.writeFileSync(envFile, userEnv);

  const result = spawnSync('bash', [path.join(ROOT, 'hooks', 'scripts', 'session-start.sh')], {
    encoding: 'utf8',
    env: withoutIngestOverride({
      HOME: home,
      CLAUDE_PLUGIN_ROOT: ROOT,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_OPTION_apiKey: API_KEY,
      CLAUDE_PLUGIN_OPTION_enableGateway: 'true',
      ANTHROPIC_BASE_URL: 'https://user-proxy.example',
      ANTHROPIC_CUSTOM_HEADERS: 'x-user: keep',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(envFile, 'utf8');
  assert.equal(written.startsWith(userEnv), true);
  assert.equal((written.match(/ANTHROPIC_BASE_URL/g) || []).length, 1);
  assert.equal((written.match(/ANTHROPIC_CUSTOM_HEADERS/g) || []).length, 1);
  assert.equal(written.includes('stale-gateway.example'), false);
  assert.equal(written.includes('X-Gateway-Api-Key'), false);
  assert.match(written, /export PRISM_GCK_KEY=gck_1234567890abcdef/);
});

test('installer preserves local config fields without publishing a routing control', () => {
  const home = makeTempDir('prism-install-');
  const binDir = path.join(home, 'bin');
  const configFile = path.join(home, '.prism', 'config.json');
  fs.mkdirSync(binDir, { recursive: true });
  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(claude, 0o755);
  writeJson(configFile, {
    apiKey: 'gck_old',
    prismThreshold: 7,
    ingest_url: 'https://local-ingest.example/prism',
    enableGateway: true,
    future: { keep: true },
  });

  const result = spawnSync('bash', [path.join(ROOT, 'install.sh'), API_KEY], {
    encoding: 'utf8',
    env: withoutIngestOverride({
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(config.apiKey, API_KEY);
  assert.equal(config.prismThreshold, 7);
  assert.equal(config.ingest_url, 'https://local-ingest.example/prism');
  assert.deepEqual(config.future, { keep: true });
  assert.equal(config.enableGateway, true);
  assert.doesNotMatch(result.stdout, /gateway/i);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
});

test('packaged and runtime surfaces contain no client routing controls', () => {
  const publicFiles = [
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    'package.json',
    'README.md',
    'install.sh',
    ...fs.readdirSync(path.join(ROOT, 'commands')).map((name) => `commands/${name}`),
  ];
  const runtimeFiles = [
    ...fs.readdirSync(path.join(ROOT, 'lib')).map((name) => `lib/${name}`),
    ...fs.readdirSync(path.join(ROOT, 'hooks', 'scripts')).map((name) => `hooks/scripts/${name}`),
  ];
  const forbidden = /enableGateway|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|X-Gateway-Api-Key|gateway routing|gateway toggle|Optra gateway/i;

  for (const relative of [...publicFiles, ...runtimeFiles]) {
    const contents = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(contents, forbidden, relative);
  }
});
