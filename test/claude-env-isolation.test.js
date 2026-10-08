require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ISOLATED_VARIABLES } = require('./helpers/isolate-claude-env');

const TEST_DIR = __dirname;
// Suites that spawn plugin scripts or run install/uninstall code in-process.
const GUARDED_SUITES = [
  'hooks-output.test.js',
  'plugin-activation.test.js',
  'settings.test.js',
  'setup-apply.test.js',
  'setup.test.js',
  'status.test.js',
  'uninstall-command.test.js',
];

function snapshotTree(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      const relative = path.relative(root, file);
      if (stat.isDirectory()) {
        entries.push(`${relative}/`);
        walk(file);
      } else {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        entries.push(`${relative}:${digest}`);
      }
    }
  };
  walk(root);
  return entries;
}

test('the test process does not see the host config variables', () => {
  for (const key of ISOLATED_VARIABLES) {
    assert.equal(Object.prototype.hasOwnProperty.call(process.env, key), false, key);
  }
});

test('every test file strips the host config variables before anything else', () => {
  const files = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.js'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const source = fs.readFileSync(path.join(TEST_DIR, name), 'utf8');
    const requireIndex = source.indexOf("require('./helpers/isolate-claude-env');");
    assert.notEqual(requireIndex, -1, `${name} must require ./helpers/isolate-claude-env`);
    const firstOtherRequire = source.search(/^(?:const|let|var) .*require\(/m);
    assert.ok(
      firstOtherRequire === -1 || requireIndex < firstOtherRequire,
      `${name} must require the isolation helper before any other module`,
    );
  }
});

test('suites run with both variables pointing at a sentinel leave it untouched', () => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-sentinel-'));
  try {
    fs.mkdirSync(path.join(sentinel, 'plugins', 'cache', 'optra-prism', 'prism', '0.0.1'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sentinel, 'plugins', 'data', 'prism-optra-prism'), { recursive: true });
    fs.writeFileSync(path.join(sentinel, 'settings.json'), '{"env":{"KEEP":"1"}}\n');
    fs.writeFileSync(
      path.join(sentinel, 'plugins', 'installed_plugins.json'),
      '{"version":2,"plugins":{"prism@optra-prism":[{"scope":"user","installPath":"/sentinel"}]}}\n',
    );
    fs.writeFileSync(
      path.join(sentinel, 'plugins', 'cache', 'optra-prism', 'prism', '0.0.1', 'marker'),
      'cache\n',
    );
    fs.writeFileSync(path.join(sentinel, 'plugins', 'data', 'prism-optra-prism', 'marker'), 'data\n');
    const before = snapshotTree(sentinel);

    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const key of ISOLATED_VARIABLES) env[key] = sentinel;
    for (const name of GUARDED_SUITES) {
      const result = spawnSync(process.execPath, [path.join(TEST_DIR, name)], {
        encoding: 'utf8',
        env,
        timeout: 120000,
      });
      assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    }
    assert.deepEqual(snapshotTree(sentinel), before);
  } finally {
    fs.rmSync(sentinel, { recursive: true, force: true });
  }
});
