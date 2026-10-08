require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, test } = require('node:test');

const { PLUGIN_ID } = require('../lib/settings');
const { inventoryPath } = require('../lib/install-inventory');

const SCRIPT = path.resolve(__dirname, '..', 'lib', 'uninstall.js');
const UNINSTALL = require('../lib/uninstall');
const created = [];

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function snapshotTree(root) {
  const snapshot = {};
  const visit = (current) => {
    const relative = path.relative(root, current) || '.';
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      snapshot[relative] = `symlink:${fs.readlinkSync(current)}`;
    } else if (stat.isDirectory()) {
      snapshot[relative] = 'directory';
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    } else {
      snapshot[relative] = fs.readFileSync(current, 'utf8');
    }
  };
  visit(root);
  return snapshot;
}

function registerPrism(root, entries) {
  writeJson(path.join(root, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: { [PLUGIN_ID]: entries },
  });
}

/**
 * A marketplace install under `cfg`, with Claude Code's own layout, a shared
 * ~/.prism, and a project directory. `cfg` is either inside or outside HOME.
 */
function profile({ inside = false, name = 'cfg' } = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-config-root-')));
  created.push(sandbox);
  const home = path.join(sandbox, 'home');
  const cfg = inside ? path.join(home, 'profiles', name) : path.join(sandbox, name);
  const projectDir = path.join(sandbox, 'project');
  const pluginRoot = path.join(cfg, 'plugins', 'cache', 'optra-prism', 'prism', '0.9.2');
  const dataDir = path.join(cfg, 'plugins', 'data', 'prism-optra-prism');
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'plugin.txt'), 'cached source\n');
  writeJson(path.join(home, '.prism', 'config.json'), { apiKey: 'shared-key' });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '0.9.2\n');
  writeJson(path.join(cfg, 'settings.json'), {
    enabledPlugins: { [PLUGIN_ID]: true, 'other@example': true },
    env: { KEEP_ME: 'yes' },
  });
  registerPrism(cfg, [{ scope: 'user', installPath: pluginRoot, version: '0.9.2' }]);
  return { sandbox, home, cfg, projectDir, pluginRoot, dataDir };
}

function run(fx, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      CLAUDE_CONFIG_DIR: fx.cfg,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
      ...env,
    },
  });
}

function commandArgs(fx, extra = []) {
  return [
    ...extra,
    '--project-dir', fx.projectDir,
    '--data-dir', fx.dataDir,
    '--plugin-root', fx.pluginRoot,
  ];
}

function preview(fx, env) {
  return run(fx, ['preview', ...commandArgs(fx)], env);
}

function tokenOf(result) {
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/^Plan token: ([0-9a-f]{64})$/m);
  assert.ok(match, result.stdout);
  return match[1];
}

function apply(fx, token, env) {
  return run(fx, ['apply', ...commandArgs(fx, ['--confirm', token])], env);
}

function otherProfile(fx, name, { installed = true } = {}) {
  const root = path.join(fx.sandbox, name);
  fs.mkdirSync(root, { recursive: true });
  if (installed) registerPrism(root, [{ scope: 'user', installPath: path.join(root, 'plugins', 'cache') }]);
  return root;
}

function writeInventory(fx, roots, overflow = false) {
  const entries = {};
  for (const root of roots) {
    entries[root] = {
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-02T00:00:00.000Z',
    };
  }
  writeJson(inventoryPath(fx.home), { version: 1, overflow, roots: entries });
}

for (const inside of [false, true]) {
  test(`uninstall under CLAUDE_CONFIG_DIR ${inside ? 'inside' : 'outside'} $HOME removes only that config root`, () => {
    const fx = profile({ inside });
    const defaultRoot = path.join(fx.home, '.claude');

    const token = tokenOf(preview(fx));
    const result = apply(fx, token);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prism plugin uninstalled for this scope\./);
    assert.match(result.stdout, /Shared artifacts removed: Prism config, Prism plugin data, Prism plugin cache\./);
    assert.deepEqual(readJson(path.join(fx.cfg, 'plugins', 'installed_plugins.json')).plugins, {});
    assert.deepEqual(readJson(path.join(fx.cfg, 'settings.json')), {
      enabledPlugins: { 'other@example': true },
      env: { KEEP_ME: 'yes' },
    });
    assert.equal(fs.existsSync(fx.dataDir), false);
    assert.equal(fs.existsSync(path.join(fx.cfg, 'plugins', 'cache', 'optra-prism', 'prism')), false);
    assert.equal(fs.existsSync(path.join(fx.home, '.prism')), false);
    assert.equal(fs.existsSync(defaultRoot), false, 'the default ~/.claude must not be created');
  });
}

test('a marketplace root is classified under the config root, not under ~/.claude', () => {
  const fx = profile();
  const result = preview(fx);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Remove marketplace plugin data at ${fx.dataDir}\\.`));
  assert.match(result.stdout, /Remove the exact Prism plugin cache at /);
  assert.equal(result.stdout.includes(path.join(fx.home, '.claude')), false);
});

test('without CLAUDE_CONFIG_DIR a root in another config dir is refused with the scrub hint', () => {
  const fx = profile();
  const before = snapshotTree(fx.sandbox);
  const env = { CLAUDE_CONFIG_DIR: '' };

  const result = preview(fx, env);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /CLAUDE_PLUGIN_DATA does not match the inline plugin root/);
  assert.match(result.stderr, /CLAUDE_CONFIG_DIR is not visible to this command/);
  assert.deepEqual(snapshotTree(fx.sandbox), before);
  const applied = apply(fx, '0'.repeat(64), env);
  assert.equal(applied.status, 2);
  assert.deepEqual(snapshotTree(fx.sandbox), before);
});

test('uninstall refuses while CLAUDE_CODE_PLUGIN_CACHE_DIR is set or CLAUDE_CONFIG_DIR is unusable', () => {
  const fx = profile();
  const before = snapshotTree(fx.sandbox);

  const cacheEnv = preview(fx, { CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(fx.sandbox, 'cache') });
  assert.equal(cacheEnv.status, 2);
  assert.match(cacheEnv.stderr, /CLAUDE_CODE_PLUGIN_CACHE_DIR is set/);

  const tilde = preview(fx, { CLAUDE_CONFIG_DIR: '~/cfg' });
  assert.equal(tilde.status, 2);
  assert.match(tilde.stderr, /"~" is not expanded/);

  const relative = preview(fx, { CLAUDE_CONFIG_DIR: 'cfg' });
  assert.equal(relative.status, 2);
  assert.match(relative.stderr, /must be an absolute path/);
  assert.deepEqual(snapshotTree(fx.sandbox), before);
});

test('a local-path marketplace root keeps uninstall\'s stricter mode mapping', () => {
  const fx = profile();
  const checkout = path.join(fx.sandbox, 'checkout');
  fs.mkdirSync(checkout, { recursive: true });
  registerPrism(fx.cfg, [{ scope: 'user', installPath: checkout }]);
  const before = snapshotTree(fx.sandbox);

  // Setup and activation accept this pair; uninstall expects prism-inline.
  const result = run(fx, ['preview', '--project-dir', fx.projectDir, '--data-dir', fx.dataDir,
    '--plugin-root', checkout]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not match the inline plugin root; expected .*prism-inline/);
  assert.deepEqual(snapshotTree(fx.sandbox), before);
});

test('a missing data directory fails the context check instead of being skipped', () => {
  const fx = profile();
  const result = run(fx, ['preview', '--project-dir', fx.projectDir, '--plugin-root', fx.pluginRoot], {
    CLAUDE_PLUGIN_DATA: '',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /plugin data directory \(CLAUDE_PLUGIN_DATA\) is not available/);
});

// ─── ~/.prism retention ───

test('~/.prism is preserved while another config root has Prism installed', () => {
  const fx = profile();
  const other = otherProfile(fx, 'other-cfg');
  writeInventory(fx, [fx.cfg, other]);

  const previewResult = preview(fx);
  assert.equal(previewResult.status, 0, previewResult.stderr);
  assert.match(previewResult.stdout, new RegExp(
    `Preserve shared Prism config at ${path.join(fx.home, '.prism')} because Prism may still be installed in other Claude config roots: ${other} \\(installed`,
  ));

  const result = apply(fx, tokenOf(previewResult));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Shared Prism config at .* was preserved because Prism may still be installed/);
  assert.equal(fs.existsSync(path.join(fx.home, '.prism', 'config.json')), true);
  // This root is gone: its registry is empty, so the inventory drops it.
  assert.deepEqual(Object.keys(readJson(inventoryPath(fx.home)).roots), [other]);
  // Nothing inside the other root was touched.
  assert.equal(readJson(path.join(other, 'plugins', 'installed_plugins.json')).plugins[PLUGIN_ID].length, 1);
});

test('the default root is probed even when no inventory exists', () => {
  const fx = profile();
  registerPrism(path.join(fx.home, '.claude'), [{ scope: 'user', installPath: '/somewhere/prism' }]);
  assert.equal(fs.existsSync(inventoryPath(fx.home)), false);

  const result = apply(fx, tokenOf(preview(fx)));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`was preserved because Prism may still be installed in other Claude config roots: ${path.join(fx.home, '.claude')} \\(installed`));
  assert.equal(fs.existsSync(path.join(fx.home, '.prism', 'config.json')), true);
  assert.equal(fs.existsSync(inventoryPath(fx.home)), false, 'the inventory file is not created by uninstall');
});

test('an unverifiable other root keeps ~/.prism', () => {
  const fx = profile();
  const other = otherProfile(fx, 'broken-cfg', { installed: false });
  fs.mkdirSync(path.join(other, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(other, 'plugins', 'installed_plugins.json'), '{broken');
  writeInventory(fx, [other]);

  const previewResult = preview(fx);
  assert.match(previewResult.stdout, /\(unverifiable: the registry cannot be read/);
  const result = apply(fx, tokenOf(previewResult));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fx.home, '.prism', 'config.json')), true);
  assert.equal(fs.readFileSync(path.join(other, 'plugins', 'installed_plugins.json'), 'utf8'), '{broken');
  assert.deepEqual(Object.keys(readJson(inventoryPath(fx.home)).roots), [other]);
});

test('an absent other root does not keep ~/.prism', () => {
  const fx = profile();
  const missing = path.join(fx.sandbox, 'deleted-cfg');
  const emptyRoot = otherProfile(fx, 'empty-cfg', { installed: false });
  writeInventory(fx, [missing, emptyRoot]);

  const result = apply(fx, tokenOf(preview(fx)));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Shared artifacts removed: Prism config/);
  assert.equal(fs.existsSync(path.join(fx.home, '.prism')), false);
});

test('a corrupt or overflowed inventory keeps ~/.prism and says why', () => {
  for (const [label, setup, expected] of [
    ['corrupt', (fx) => {
      fs.writeFileSync(inventoryPath(fx.home), '{corrupt');
    }, /the install inventory is corrupt/],
    ['overflow', (fx) => writeInventory(fx, [], true), /the install inventory is full/],
  ]) {
    const fx = profile();
    setup(fx);
    const inventoryBefore = fs.readFileSync(inventoryPath(fx.home), 'utf8');

    const previewResult = preview(fx);
    assert.match(previewResult.stdout, expected, label);
    const result = apply(fx, tokenOf(previewResult));

    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.match(result.stdout, expected, label);
    assert.equal(fs.existsSync(path.join(fx.home, '.prism', 'config.json')), true, label);
    assert.equal(fs.readFileSync(inventoryPath(fx.home), 'utf8'), inventoryBefore, label);
  }
});

test('the current root reached through a symlink alias is not counted as another root', () => {
  const fx = profile();
  const alias = path.join(fx.sandbox, 'cfg-alias');
  fs.symlinkSync(fx.cfg, alias);
  writeInventory(fx, [alias]);

  const result = apply(fx, tokenOf(preview(fx)));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fx.home, '.prism')), false);
});

test('a kept install in this registry still preserves ~/.prism and the inventory entry', () => {
  const fx = profile();
  const checkoutProject = path.join(fx.sandbox, 'second-project');
  fs.mkdirSync(checkoutProject, { recursive: true });
  registerPrism(fx.cfg, [
    { scope: 'user', installPath: fx.pluginRoot, version: '0.9.2' },
    { scope: 'local', projectPath: checkoutProject, installPath: fx.pluginRoot },
  ]);
  writeInventory(fx, [fx.cfg]);

  const result = apply(fx, tokenOf(preview(fx)));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fx.home, '.prism', 'config.json')), true);
  assert.deepEqual(Object.keys(readJson(inventoryPath(fx.home)).roots), [fx.cfg]);
});

// ─── plan token binding ───

test('the plan token refuses when another root becomes installed between preview and apply', () => {
  const fx = profile();
  const other = otherProfile(fx, 'late-cfg', { installed: false });
  writeInventory(fx, [other]);
  const token = tokenOf(preview(fx));
  registerPrism(other, [{ scope: 'user', installPath: path.join(other, 'plugins', 'cache') }]);
  const before = snapshotTree(fx.sandbox);

  const result = apply(fx, token);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /plan token does not match/);
  assert.deepEqual(snapshotTree(fx.sandbox), before);
});

test('the plan token ignores lastSeen refreshes and pruned absent entries', () => {
  const fx = profile();
  const gone = path.join(fx.sandbox, 'gone-cfg');
  writeInventory(fx, [fx.cfg, gone]);
  const token = tokenOf(preview(fx));

  // Another profile's activity refreshes timestamps; setup elsewhere prunes the absent root.
  writeJson(inventoryPath(fx.home), {
    version: 1,
    overflow: false,
    roots: { [fx.cfg]: { firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-10-08T00:00:00.000Z' } },
  });

  const result = apply(fx, token);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fx.home, '.prism')), false);
});

test('the plan token changes when the inventory condition changes', () => {
  const fx = profile();
  const first = tokenOf(preview(fx));
  writeInventory(fx, [], true);
  const second = tokenOf(preview(fx));
  fs.writeFileSync(inventoryPath(fx.home), '{corrupt');
  const third = tokenOf(preview(fx));

  assert.equal(new Set([first, second, third]).size, 3);
});

test('applyPlan re-verifies other roots right before removing ~/.prism', () => {
  const fx = profile();
  const other = otherProfile(fx, 'racing-cfg', { installed: false });
  writeInventory(fx, [fx.cfg, other]);
  const saved = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.HOME = fx.home;
  process.env.CLAUDE_CONFIG_DIR = fx.cfg;
  try {
    const plan = UNINSTALL.buildPlan({
      projectDir: fx.projectDir,
      dataDir: fx.dataDir,
      pluginRoot: fx.pluginRoot,
    });
    assert.equal(plan.removePrismConfig, true);

    const result = UNINSTALL.applyPlan(plan, {
      // The other profile installs Prism after this registry was committed.
      afterRegistryCommitFn: () => {
        registerPrism(other, [{ scope: 'user', installPath: path.join(other, 'plugins', 'cache') }]);
      },
    });

    assert.match(result.prismConfigPreserved, /Prism may still be installed in other Claude config roots/);
    assert.equal(result.removedShared.includes('Prism config'), false);
    assert.equal(result.removedShared.includes('Prism plugin data'), true);
    assert.equal(fs.existsSync(path.join(fx.home, '.prism', 'config.json')), true);
    assert.match(UNINSTALL.renderApplied(plan, result), /Shared Prism config at .* was preserved because/);
    assert.deepEqual(Object.keys(readJson(inventoryPath(fx.home)).roots), [other]);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
