const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const API_KEY = 'prism_1234567890abcdef';
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

function hostilePrismEnv(extra = {}) {
  return {
    ...process.env,
    PRISM_API_KEY: 'hostile-prism-key',
    PRISM_GCK_KEY: 'hostile-gck-key',
    PRISM_INGEST_URL: 'https://hostile-ingest.invalid',
    PRISM_THRESHOLD: '99',
    PRISM_DEBUG: '1',
    CLAUDE_PLUGIN_OPTION_APIKEY: 'hostile-option-key',
    CLAUDE_PLUGIN_OPTION_apiKey: 'hostile-compat-key',
    CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD: '88',
    CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY: 'true',
    CLAUDE_PLUGIN_OPTION_enableGateway: 'true',
    ...extra,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('runtime exports use config.json and ignore stale cache, Prism env, and plugin options', () => {
  const home = makeTempDir('prism-runtime-');
  writeJson(path.join(home, '.prism', 'config.json'), {
    apiKey: API_KEY,
    ingest_url: 'https://config-ingest.example',
    show_realtime_summary: false,
    enableGateway: true,
  });
  writeJson(path.join(home, '.prism', 'config-cache.json'), {
    ingest_url: 'https://stale-cache.example',
    gateway_url: 'https://stale-gateway.example',
    anthropic_base_url: 'https://stale-anthropic.example',
    source: 'auth-error',
  });

  const result = spawnSync(process.execPath, ['-e', `
    const runtime = require(${JSON.stringify(path.join(ROOT, 'lib', 'env.js'))});
    process.stdout.write(JSON.stringify(runtime));
  `], {
    encoding: 'utf8',
    env: hostilePrismEnv({ HOME: home }),
  });

  assert.equal(result.status, 0, result.stderr);
  const runtime = JSON.parse(result.stdout);
  assert.equal(runtime.API_KEY, API_KEY);
  assert.equal(runtime.INGEST_URL, 'https://config-ingest.example');
  assert.equal(Object.hasOwn(runtime, 'PRISM_THRESHOLD'), false);
  assert.equal(runtime.SHOW_REALTIME_SUMMARY, false);
  assert.equal(runtime.DEBUG_ENABLED, false);
  assert.equal(Object.hasOwn(runtime, 'GCK_KEY'), false);
  assert.equal(Object.hasOwn(runtime, 'ENABLE_GATEWAY'), false);
  assert.equal(Object.hasOwn(runtime, 'GATEWAY_URL'), false);
  assert.doesNotMatch(JSON.stringify(runtime), /hostile|stale-/);
});

test('SessionStart accepts an opaque config key and never rewrites the host env file', () => {
  const home = makeTempDir('prism-session-');
  const dataDir = path.join(home, 'plugin-data');
  const envFile = path.join(home, 'claude-env');
  const sentinel = path.join(home, 'injected');
  const opaqueKey = `opaque_'"\`;\nexport PRISM_INJECTED=1\n$(touch ${sentinel})`;
  const userEnv = [
    'export ANTHROPIC_BASE_URL=https://user-proxy.example',
    'export ANTHROPIC_CUSTOM_HEADERS="x-user: keep"',
    '',
  ].join('\n');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(envFile, userEnv);
  writeJson(path.join(home, '.prism', 'config.json'), {
    apiKey: opaqueKey,
    ingest_url: 'https://config-ingest.example',
  });
  writeJson(path.join(home, '.prism', 'config-cache.json'), {
    ingest_url: 'https://stale-cache.example',
    gateway_url: 'https://stale-gateway.example',
    source: 'auth-error',
    auth_status: 401,
  });

  const result = spawnSync('bash', [path.join(ROOT, 'hooks', 'scripts', 'session-start.sh')], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'opaque-config-session', source: 'startup' }),
    env: hostilePrismEnv({
      HOME: home,
      CLAUDE_PLUGIN_ROOT: ROOT,
      CLAUDE_PLUGIN_DATA: dataDir,
      CLAUDE_ENV_FILE: envFile,
      ANTHROPIC_BASE_URL: 'https://user-proxy.example',
      ANTHROPIC_CUSTOM_HEADERS: 'x-user: keep',
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Session started/);
  assert.match(result.stderr, /Ingest:\s+https:\/\/config-ingest\.example/);
  assert.doesNotMatch(result.stderr, /rejected|invalid.*key|stale-/i);
  assert.equal(result.stderr.includes(opaqueKey), false);
  assert.equal(fs.readFileSync(envFile, 'utf8'), userEnv);
  assert.doesNotMatch(fs.readFileSync(envFile, 'utf8'), /PRISM_(?:API_KEY|GCK_KEY|THRESHOLD)/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('setup command passes the opaque key positionally', () => {
  const contents = fs.readFileSync(path.join(ROOT, 'commands', 'setup.md'), 'utf8');

  assert.match(contents, /Treat the key as opaque/);
  assert.match(contents, /lib\/setup\.js" apply "\$KEY"/);
  assert.doesNotMatch(contents, /PRISM_API_KEY=/);
  assert.doesNotMatch(contents, /--scope/);
});

test('public setup guidance only presents Prism API keys', () => {
  const publicGuidanceFiles = [
    '.claude-plugin/plugin.json',
    'README.md',
    ...fs.readdirSync(path.join(ROOT, 'commands')).map((name) => `commands/${name}`),
  ];

  for (const relative of publicGuidanceFiles) {
    const contents = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(contents, /gck_/i, relative);
  }
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
  const forbidden = /enableGateway|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|X-Gateway-Api-Key|gateway routing|gateway toggle|Optra gateway|key_prefix/i;

  for (const relative of [...publicFiles, ...runtimeFiles]) {
    const contents = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(contents, forbidden, relative);
  }
});
