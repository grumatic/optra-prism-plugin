require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');
const { LEGACY_HOST_VERSION, pinClaudeHostVersion } = require('./helpers/claude-host');

// Status and doctor are read-only reports of the install context and other roots.
pinClaudeHostVersion(LEGACY_HOST_VERSION);

const ROOT = path.resolve(__dirname, '..');
const STATUS = path.join(ROOT, 'lib', 'status.js');
const DOCTOR = path.join(ROOT, 'lib', 'doctor.js');
const created = [];

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshotTree(root) {
  const snapshot = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`dir:${file}`);
        walk(file);
      } else {
        snapshot.push(`file:${file}:${fs.readFileSync(file).toString('base64')}`);
      }
    }
  };
  walk(root);
  return snapshot;
}

function fixture() {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-context-report-')));
  created.push(sandbox);
  const home = path.join(sandbox, 'home');
  const cfg = path.join(sandbox, 'cfg');
  const projectDir = path.join(sandbox, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  writeJson(path.join(home, '.prism', 'config.json'), {
    apiKey: 'prism_context_report',
    ingest_url: 'http://127.0.0.1:1',
  });
  writeJson(path.join(cfg, 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [{ scope: 'user', installPath: ROOT }] },
  });
  return {
    sandbox,
    home,
    cfg,
    projectDir,
    dataDir: path.join(cfg, 'plugins', 'data', 'prism-inline'),
  };
}

function runScript(script, fx, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      CLAUDE_CONFIG_DIR: fx.cfg,
      ...env,
    },
  });
}

const statusArgs = (fx, dataDir = fx.dataDir) => [
  '--project-dir', fx.projectDir,
  ...(dataDir ? ['--data-dir', dataDir] : []),
];

test('status reports the config root, its source, and a matching install context', () => {
  const fx = fixture();
  const before = snapshotTree(fx.sandbox);

  const result = runScript(STATUS, fx, statusArgs(fx));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`\\*\\*Claude config root:\\*\\* ${fx.cfg} \\(source: CLAUDE_CONFIG_DIR\\)`));
  assert.match(result.stdout, new RegExp(`\\*\\*Install context:\\*\\* ok \\(inline install; plugin data ${fx.dataDir}\\)`));
  assert.match(result.stdout, /\*\*Install scope:\*\* user/);
  assert.match(result.stdout, /\*\*Other Claude config roots:\*\*\n- .*\.claude: absent/);
  assert.deepEqual(snapshotTree(fx.sandbox), before, 'status must not write');
});

test('status reports the default root and a missing data dir as not checked', () => {
  const fx = fixture();
  fs.cpSync(path.join(fx.cfg, 'plugins'), path.join(fx.home, '.claude', 'plugins'), { recursive: true });

  const result = runScript(STATUS, fx, statusArgs(fx, null), { CLAUDE_CONFIG_DIR: '' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`\\*\\*Claude config root:\\*\\* ${path.join(fx.home, '.claude')} \\(source: default\\)`));
  assert.match(result.stdout, /\*\*Install context:\*\* not checked \(the plugin data directory/);
  assert.match(result.stdout, /\*\*Other Claude config roots:\*\* none/);
});

test('status shows both paths on a mismatch and the scrub hint when the variable is not visible', () => {
  const fx = fixture();

  const mismatch = runScript(STATUS, fx, statusArgs(fx, path.join(fx.home, '.claude', 'plugins', 'data', 'prism-inline')));
  assert.equal(mismatch.status, 0, mismatch.stderr);
  assert.match(mismatch.stdout, /\*\*Install context:\*\* mismatch \(CLAUDE_PLUGIN_DATA does not match the inline plugin root/);
  assert.match(mismatch.stdout, new RegExp(`plugin root ${ROOT}; plugin data `));

  const scrubbed = runScript(STATUS, fx, statusArgs(fx), { CLAUDE_CONFIG_DIR: '' });
  assert.equal(scrubbed.status, 0, scrubbed.stderr);
  assert.match(scrubbed.stdout, /\*\*Install context:\*\* mismatch/);
  assert.match(scrubbed.stdout, /CLAUDE_CONFIG_DIR is not visible to this command \(possibly removed by CLAUDE_CODE_SUBPROCESS_ENV_SCRUB\)/);
});

test('status reports an invalid CLAUDE_CONFIG_DIR and CLAUDE_CODE_PLUGIN_CACHE_DIR without writing', () => {
  const fx = fixture();
  const before = snapshotTree(fx.sandbox);

  const invalid = runScript(STATUS, fx, statusArgs(fx), { CLAUDE_CONFIG_DIR: '~/cfg' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /\*\*Claude config root:\*\* invalid \(.*"~" is not expanded; use an absolute path\)/);
  assert.equal(invalid.stderr, '');

  const cacheDir = runScript(STATUS, fx, statusArgs(fx), {
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(fx.sandbox, 'plugin-cache'),
  });
  assert.equal(cacheDir.status, 0, cacheDir.stderr);
  assert.match(cacheDir.stdout, /\*\*CLAUDE_CODE_PLUGIN_CACHE_DIR:\*\* set to .*not supported/);
  assert.deepEqual(snapshotTree(fx.sandbox), before);
});

test('status and doctor list other roots and name a corrupt or full inventory', () => {
  const fx = fixture();
  const other = path.join(fx.sandbox, 'other-cfg');
  writeJson(path.join(other, 'plugins', 'installed_plugins.json'), {
    plugins: { 'prism@optra-prism': [{ scope: 'user', installPath: '/x/prism' }] },
  });
  writeJson(path.join(fx.home, '.prism', 'installs.json'), {
    version: 1,
    overflow: true,
    roots: { [other]: { firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' } },
  });
  const status = runScript(STATUS, fx, statusArgs(fx));
  assert.match(status.stdout, new RegExp(`- ${other}: installed \\(1 Prism registry entry\\)`));
  assert.match(status.stdout, /\*\*Install inventory:\*\* full; .*preserves ~\/\.prism/);

  const doctor = runScript(DOCTOR, fx, ['--json', ...statusArgs(fx)]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.ok(report.notices.includes(`Other Claude config root ${other}: installed (1 Prism registry entry)`));
  assert.ok(report.notices.some((notice) => /install inventory is full/.test(notice)));

  fs.writeFileSync(path.join(fx.home, '.prism', 'installs.json'), '{corrupt');
  const corrupt = runScript(STATUS, fx, statusArgs(fx));
  assert.match(corrupt.stdout, /\*\*Install inventory:\*\* corrupt \(/);
  const corruptDoctor = JSON.parse(runScript(DOCTOR, fx, ['--json', ...statusArgs(fx)]).stdout);
  assert.ok(corruptDoctor.notices.some((notice) => /install inventory is corrupt/.test(notice)));
  assert.equal(fs.readFileSync(path.join(fx.home, '.prism', 'installs.json'), 'utf8'), '{corrupt');
});

test('doctor has an Install Context check that passes, fails, skips, and warns', () => {
  const fx = fixture();
  const contextCheck = (result) => JSON.parse(result.stdout).checks
    .find((check) => check.id === 'install-context');

  const ok = contextCheck(runScript(DOCTOR, fx, ['--json', ...statusArgs(fx)]));
  assert.equal(ok.status, 'pass');
  assert.match(ok.message, new RegExp(`Claude config root ${fx.cfg} \\(source: CLAUDE_CONFIG_DIR\\)`));

  const mismatch = contextCheck(runScript(DOCTOR, fx, ['--json', ...statusArgs(fx)], { CLAUDE_CONFIG_DIR: '' }));
  assert.equal(mismatch.status, 'fail');
  assert.match(mismatch.message, /CLAUDE_CONFIG_DIR is not visible to this command/);
  assert.match(mismatch.remediation, /same CLAUDE_CONFIG_DIR/);

  const skipped = contextCheck(runScript(DOCTOR, fx, ['--json', '--project-dir', fx.projectDir]));
  assert.equal(skipped.status, 'skip');

  const warned = contextCheck(runScript(DOCTOR, fx, ['--json', ...statusArgs(fx)], {
    CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(fx.sandbox, 'plugin-cache'),
  }));
  assert.equal(warned.status, 'warn');
  assert.match(warned.message, /CLAUDE_CODE_PLUGIN_CACHE_DIR is set/);
});

test('doctor reports an invalid CLAUDE_CONFIG_DIR instead of crashing', () => {
  const fx = fixture();

  const result = runScript(DOCTOR, fx, ['--json', ...statusArgs(fx)], { CLAUDE_CONFIG_DIR: 'relative/cfg' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId['install-context'].status, 'fail');
  assert.match(byId['install-context'].message, /Claude config root is invalid: .*absolute path/);
  assert.equal(byId['otel-settings'].status, 'skip');
  assert.equal(byId['otel-headers-helper'].status, 'skip');
  assert.equal(report.checks.length, 5);
});
