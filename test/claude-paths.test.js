require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const {
  ClaudePathsError,
  assertPluginContext,
  canonicalizeWithExistingAncestor,
  checkPluginContext,
  defaultPluginDataDir,
  inspectClaudeContext,
  resolveClaudePaths,
  resolveClaudePathsForMutation,
} = require('../lib/claude-paths');

const roots = [];
function tempRoot() {
  // realpath: macOS /var -> /private/var, so expectations compare canonical paths.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-claude-paths-')));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const HOME = '/home/dev';

test('an unset or empty CLAUDE_CONFIG_DIR resolves to ~/.claude', () => {
  for (const env of [{}, { CLAUDE_CONFIG_DIR: '' }]) {
    const paths = resolveClaudePaths({ env, homeDir: HOME });
    assert.equal(paths.source, 'default');
    assert.equal(paths.configRoot, '/home/dev/.claude');
    assert.equal(paths.userSettings, '/home/dev/.claude/settings.json');
    assert.equal(paths.installedPlugins, '/home/dev/.claude/plugins/installed_plugins.json');
    assert.equal(paths.pluginCacheRoot, '/home/dev/.claude/plugins/cache');
    assert.equal(paths.pluginDataRoot, '/home/dev/.claude/plugins/data');
    assert.equal(paths.pluginCacheDirEnv, null);
  }
});

test('an absolute CLAUDE_CONFIG_DIR is normalized without a trailing slash or dot segments', () => {
  const cases = [
    ['/srv/cfg', '/srv/cfg'],
    ['/srv/cfg/', '/srv/cfg'],
    ['/srv/cfg///', '/srv/cfg'],
    ['/srv/a/../cfg', '/srv/cfg'],
    ['/srv/./cfg', '/srv/cfg'],
  ];
  for (const [value, expected] of cases) {
    const paths = resolveClaudePaths({ env: { CLAUDE_CONFIG_DIR: value }, homeDir: HOME });
    assert.equal(paths.source, 'env', value);
    assert.equal(paths.configRoot, expected, value);
    assert.equal(paths.userSettings, `${expected}/settings.json`);
    assert.equal(paths.pluginDataRoot, `${expected}/plugins/data`);
  }
});

test('a relative, tilde, or NUL CLAUDE_CONFIG_DIR throws instead of falling back', () => {
  for (const value of ['cfg', './cfg', '../cfg', '~', '~/cfg', '~user/cfg']) {
    assert.throws(
      () => resolveClaudePaths({ env: { CLAUDE_CONFIG_DIR: value }, homeDir: HOME }),
      ClaudePathsError,
      value,
    );
  }
  assert.throws(
    () => resolveClaudePaths({ env: { CLAUDE_CONFIG_DIR: '~/cfg' }, homeDir: HOME }),
    /"~" is not expanded; use an absolute path/,
  );
  assert.throws(
    () => resolveClaudePaths({ env: { CLAUDE_CONFIG_DIR: '/srv/c\0fg' }, homeDir: HOME }),
    /NUL/,
  );
});

test('resolution reads the environment on every call', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '/srv/one';
    assert.equal(resolveClaudePaths().configRoot, '/srv/one');
    process.env.CLAUDE_CONFIG_DIR = '/srv/two';
    assert.equal(resolveClaudePaths().configRoot, '/srv/two');
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(resolveClaudePaths().source, 'default');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }

  const settings = require('../lib/settings');
  const before = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = '/srv/live';
    assert.equal(settings.userSettingsPath(), '/srv/live/settings.json');
    assert.equal(settings.USER_SETTINGS, '/srv/live/settings.json');
    assert.equal(settings.INSTALLED_PLUGINS, '/srv/live/plugins/installed_plugins.json');
    assert.equal(settings.pathForScope('user'), '/srv/live/settings.json');
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  }
});

test('CLAUDE_CODE_PLUGIN_CACHE_DIR is reported and refused by mutating resolution', () => {
  const env = { CLAUDE_CODE_PLUGIN_CACHE_DIR: '/srv/plugin-cache' };
  assert.equal(resolveClaudePaths({ env, homeDir: HOME }).pluginCacheDirEnv, '/srv/plugin-cache');
  assert.throws(
    () => resolveClaudePathsForMutation({ env, homeDir: HOME }),
    /CLAUDE_CODE_PLUGIN_CACHE_DIR is set/,
  );
  assert.equal(
    resolveClaudePaths({ env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: '' }, homeDir: HOME }).pluginCacheDirEnv,
    null,
  );
});

test('a symlinked config root is compared by its canonical form', () => {
  const root = tempRoot();
  const real = path.join(root, 'dotfiles', 'claude');
  const alias = path.join(root, 'home', '.claude');
  fs.mkdirSync(path.join(real, 'plugins', 'cache', 'optra-prism', 'prism', '1.0.0'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(real, 'plugins', 'data', 'prism-optra-prism'), { recursive: true });
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.symlinkSync(real, alias);

  assert.equal(canonicalizeWithExistingAncestor(alias), real);
  assert.equal(canonicalizeWithExistingAncestor(path.join(alias, 'missing', 'leaf')),
    path.join(real, 'missing', 'leaf'));

  // The host may hand over either spelling of the same directory.
  const paths = resolveClaudePaths({ env: { CLAUDE_CONFIG_DIR: alias }, homeDir: HOME });
  for (const [pluginRoot, dataDir] of [
    [path.join(alias, 'plugins', 'cache', 'optra-prism', 'prism', '1.0.0'),
      path.join(real, 'plugins', 'data', 'prism-optra-prism')],
    [path.join(real, 'plugins', 'cache', 'optra-prism', 'prism', '1.0.0'),
      path.join(alias, 'plugins', 'data', 'prism-optra-prism')],
  ]) {
    const result = checkPluginContext({ pluginRoot, dataDir, paths });
    assert.equal(result.status, 'ok', result.reason);
    assert.equal(result.mode, 'marketplace');
  }
});

function contextFixture() {
  const root = tempRoot();
  const cfg = path.join(root, 'cfg');
  const cache = path.join(cfg, 'plugins', 'cache');
  const data = path.join(cfg, 'plugins', 'data');
  const marketplaceRoot = path.join(cache, 'optra-prism', 'prism', '1.0.0');
  const siblingRoot = path.join(cache, 'optra-prism', 'other', '1.0.0');
  const foreignCacheRoot = path.join(cache, 'someone-else', 'prism', '1.0.0');
  const localRoot = path.join(root, 'checkout');
  for (const dir of [marketplaceRoot, siblingRoot, foreignCacheRoot, localRoot,
    path.join(data, 'prism-optra-prism'), path.join(data, 'prism-inline')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const paths = resolveClaudePaths({ env: { CLAUDE_CONFIG_DIR: cfg }, homeDir: path.join(root, 'home') });
  return {
    root, cfg, data, paths, marketplaceRoot, siblingRoot, foreignCacheRoot, localRoot,
    marketplaceData: path.join(data, 'prism-optra-prism'),
    inlineData: path.join(data, 'prism-inline'),
  };
}

test('D2 rule table: a marketplace root requires the prism-optra-prism data directory', () => {
  const fx = contextFixture();
  const ok = checkPluginContext({
    pluginRoot: fx.marketplaceRoot, dataDir: fx.marketplaceData, paths: fx.paths,
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.mode, 'marketplace');

  const wrong = checkPluginContext({
    pluginRoot: fx.marketplaceRoot, dataDir: fx.inlineData, paths: fx.paths,
  });
  assert.equal(wrong.status, 'mismatch');
  assert.match(wrong.reason, /does not match the marketplace plugin root; expected .*prism-optra-prism$/);
});

test('D2 rule table: a root inside the cache but outside optra-prism/prism is refused', () => {
  const fx = contextFixture();
  for (const pluginRoot of [fx.siblingRoot, fx.foreignCacheRoot]) {
    for (const dataDir of [fx.marketplaceData, fx.inlineData]) {
      const result = checkPluginContext({ pluginRoot, dataDir, paths: fx.paths });
      assert.equal(result.status, 'mismatch', pluginRoot);
      assert.match(result.reason, /inside the plugin cache but outside/);
    }
  }
  // The cache directory itself is not a strict descendant of optra-prism/prism either.
  const ownCache = path.join(fx.paths.pluginCacheRoot, 'optra-prism', 'prism');
  assert.equal(
    checkPluginContext({ pluginRoot: ownCache, dataDir: fx.marketplaceData, paths: fx.paths }).status,
    'mismatch',
  );
});

test('D2 rule table: a root outside the cache accepts prism-inline or prism-optra-prism', () => {
  const fx = contextFixture();
  for (const dataDir of [fx.inlineData, fx.marketplaceData]) {
    const result = checkPluginContext({ pluginRoot: fx.localRoot, dataDir, paths: fx.paths });
    assert.equal(result.status, 'ok', result.reason);
    assert.equal(result.mode, 'inline');
  }
  const other = checkPluginContext({
    pluginRoot: fx.localRoot,
    dataDir: path.join(fx.data, 'prism-elsewhere'),
    paths: fx.paths,
  });
  assert.equal(other.status, 'mismatch');
  assert.match(other.reason, /expected .*prism-inline or .*prism-optra-prism/);
});

test('a missing input is a mismatch for mutating checks and not-checked for reports', () => {
  const fx = contextFixture();
  const mutating = checkPluginContext({
    pluginRoot: fx.localRoot, dataDir: undefined, paths: fx.paths, mutating: true,
  });
  assert.equal(mutating.status, 'mismatch');
  assert.match(mutating.reason, /plugin data directory \(CLAUDE_PLUGIN_DATA\) is not available/);

  const report = checkPluginContext({
    pluginRoot: fx.localRoot, dataDir: undefined, paths: fx.paths, mutating: false,
  });
  assert.equal(report.status, 'not-checked');

  assert.equal(
    checkPluginContext({
      pluginRoot: undefined, dataDir: fx.inlineData, paths: fx.paths, mutating: true,
    }).status,
    'mismatch',
  );
  assert.equal(
    checkPluginContext({
      pluginRoot: fx.localRoot, dataDir: 'relative/data', paths: fx.paths, mutating: false,
    }).status,
    'mismatch',
  );
});

test('a default-root mismatch under another plugins/data directory carries the scrub hint', () => {
  const fx = contextFixture();
  const home = path.join(fx.root, 'home');
  const defaultPaths = resolveClaudePaths({ env: {}, homeDir: home });
  const scrubbed = checkPluginContext({
    pluginRoot: fx.marketplaceRoot,
    dataDir: fx.marketplaceData,
    paths: defaultPaths,
  });
  assert.equal(scrubbed.status, 'mismatch');
  assert.match(scrubbed.hint, /CLAUDE_CONFIG_DIR is not visible to this command/);
  assert.match(scrubbed.hint, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB/);

  // An explicit config root never gets the hint, and neither does a data
  // directory that sits under the current root.
  const explicit = checkPluginContext({
    pluginRoot: fx.marketplaceRoot, dataDir: fx.inlineData, paths: fx.paths,
  });
  assert.equal(explicit.hint, null);
  const ownRoot = checkPluginContext({
    pluginRoot: fx.marketplaceRoot,
    dataDir: path.join(home, '.claude', 'plugins', 'data', 'prism-elsewhere'),
    paths: defaultPaths,
  });
  assert.equal(ownRoot.status, 'mismatch');
  assert.equal(ownRoot.hint, null);
});

test('assertPluginContext throws for a mismatch and while CLAUDE_CODE_PLUGIN_CACHE_DIR is set', () => {
  const fx = contextFixture();
  assert.deepEqual(
    assertPluginContext({
      pluginRoot: fx.localRoot, dataDir: fx.inlineData, paths: fx.paths,
    }).context.mode,
    'inline',
  );
  assert.throws(
    () => assertPluginContext({
      pluginRoot: fx.marketplaceRoot, dataDir: fx.inlineData, paths: fx.paths,
    }),
    ClaudePathsError,
  );
  const withCacheEnv = { ...fx.paths, pluginCacheDirEnv: '/srv/cache' };
  assert.throws(
    () => assertPluginContext({
      pluginRoot: fx.localRoot, dataDir: fx.inlineData, paths: withCacheEnv,
    }),
    /CLAUDE_CODE_PLUGIN_CACHE_DIR is set/,
  );
});

test('inspectClaudeContext reports instead of throwing', () => {
  const fx = contextFixture();
  const invalid = inspectClaudeContext({
    pluginRoot: fx.localRoot,
    dataDir: fx.inlineData,
    env: { CLAUDE_CONFIG_DIR: 'relative', CLAUDE_CODE_PLUGIN_CACHE_DIR: '/srv/cache' },
  });
  assert.match(invalid.error, /absolute path/);
  assert.equal(invalid.pluginCacheDirEnv, '/srv/cache');
  assert.equal(invalid.context, null);

  const valid = inspectClaudeContext({
    pluginRoot: fx.localRoot,
    dataDir: fx.inlineData,
    env: { CLAUDE_CONFIG_DIR: fx.cfg },
  });
  assert.equal(valid.error, null);
  assert.equal(valid.context.status, 'ok');
});

test('the fallback plugin data directory follows CLAUDE_CONFIG_DIR and survives an invalid value', () => {
  assert.equal(
    defaultPluginDataDir({ env: { CLAUDE_CONFIG_DIR: '/srv/cfg' }, homeDir: HOME }),
    '/srv/cfg/plugins/data/prism-optra-prism',
  );
  assert.equal(
    defaultPluginDataDir({ env: {}, homeDir: HOME }),
    '/home/dev/.claude/plugins/data/prism-optra-prism',
  );
  assert.equal(
    defaultPluginDataDir({ env: { CLAUDE_CONFIG_DIR: '~/cfg' }, homeDir: HOME }),
    '/home/dev/.claude/plugins/data/prism-optra-prism',
  );
});

test('runtime stores fall back to the data directory under CLAUDE_CONFIG_DIR when CLAUDE_PLUGIN_DATA is unset', () => {
  const cfg = '/srv/cfg-fallback';
  const saved = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
  };
  process.env.CLAUDE_CONFIG_DIR = cfg;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    const expected = path.join(cfg, 'plugins', 'data', 'prism-optra-prism');
    const outbox = require('../lib/response-outbox');
    assert.equal(outbox.getOutboxDir(), path.join(expected, 'runtime', 'outbox'));
    assert.equal(
      outbox.getTerminalRejectedDir(),
      path.join(expected, 'runtime', 'outbox-terminal-rejected'),
    );
    assert.equal(
      require('../lib/git-evidence-contract').installKeyPath(),
      path.join(expected, 'runtime', 'git-evidence-install-key-v1'),
    );

    process.env.CLAUDE_PLUGIN_DATA = '/srv/explicit-data';
    assert.equal(outbox.getOutboxDir(), '/srv/explicit-data/runtime/outbox');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
