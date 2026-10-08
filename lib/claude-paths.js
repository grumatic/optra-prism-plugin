/**
 * Resolves where Claude Code keeps its user configuration.
 *
 * Claude Code relocates the user settings file and the whole plugins tree
 * (installed_plugins.json, cache, data) to $CLAUDE_CONFIG_DIR when it is set.
 * Every host path in the plugin is derived from this module and resolved per
 * call, so tests and long-lived processes see the current environment.
 *
 * Project and local settings, and the HOME-based ~/.prism, are not affected.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const PLUGIN_CACHE_DIR_ENV = 'CLAUDE_CODE_PLUGIN_CACHE_DIR';
const MARKETPLACE_NAME = 'optra-prism';
const PLUGIN_NAME = 'prism';
const MARKETPLACE_DATA_DIR_NAME = `${PLUGIN_NAME}-${MARKETPLACE_NAME}`;
const INLINE_DATA_DIR_NAME = `${PLUGIN_NAME}-inline`;

class ClaudePathsError extends Error {}

function configRootFromEnv(env, homeDir) {
  const value = env[CONFIG_DIR_ENV];
  if (value === undefined || value === null || value === '') {
    return { configRoot: path.join(homeDir, '.claude'), source: 'default' };
  }
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new ClaudePathsError(`${CONFIG_DIR_ENV} must be an absolute path without NUL characters`);
  }
  if (value.startsWith('~')) {
    throw new ClaudePathsError(
      `${CONFIG_DIR_ENV} must be an absolute path: "~" is not expanded; use an absolute path`,
    );
  }
  if (!path.isAbsolute(value)) {
    throw new ClaudePathsError(`${CONFIG_DIR_ENV} must be an absolute path`);
  }
  return { configRoot: path.resolve(value), source: 'env' };
}

/**
 * CLAUDE_CONFIG_DIR unset or empty -> <home>/.claude (source 'default').
 * Set and absolute -> path.resolve(value) (source 'env').
 * Set but relative (including a leading "~") or containing NUL -> throws; there
 * is no fallback to the default.
 *
 * `pluginCacheDirEnv` carries CLAUDE_CODE_PLUGIN_CACHE_DIR when it is set: that
 * variable relocates the plugins tree independently of the config root and is
 * not supported, so mutating commands refuse while it is present.
 */
function resolveClaudePaths({ env = process.env, homeDir = os.homedir() } = {}) {
  const { configRoot, source } = configRootFromEnv(env, homeDir);
  const pluginCacheDirEnv = typeof env[PLUGIN_CACHE_DIR_ENV] === 'string'
    && env[PLUGIN_CACHE_DIR_ENV] !== ''
    ? env[PLUGIN_CACHE_DIR_ENV]
    : null;
  return {
    configRoot,
    userSettings: path.join(configRoot, 'settings.json'),
    installedPlugins: path.join(configRoot, 'plugins', 'installed_plugins.json'),
    pluginCacheRoot: path.join(configRoot, 'plugins', 'cache'),
    pluginDataRoot: path.join(configRoot, 'plugins', 'data'),
    source,
    pluginCacheDirEnv,
  };
}

function pluginCacheDirRefusal(paths) {
  return paths.pluginCacheDirEnv === null
    ? null
    : `${PLUGIN_CACHE_DIR_ENV} is set; relocating the plugins tree separately from ` +
      `${CONFIG_DIR_ENV} is not supported. Unset it and retry.`;
}

/** Same as resolveClaudePaths, but throws while CLAUDE_CODE_PLUGIN_CACHE_DIR is set. */
function resolveClaudePathsForMutation(options) {
  const paths = resolveClaudePaths(options);
  const refusal = pluginCacheDirRefusal(paths);
  if (refusal) throw new ClaudePathsError(refusal);
  return paths;
}

/**
 * Plugin data directory used when CLAUDE_PLUGIN_DATA is unset. Hooks must keep
 * running when the environment is unusable, so an invalid CLAUDE_CONFIG_DIR
 * falls back to the v0.9.2 default location instead of throwing.
 */
function defaultPluginDataDir(options = {}) {
  let paths;
  try {
    paths = resolveClaudePaths(options);
  } catch {
    const homeDir = options.homeDir || os.homedir();
    return path.join(homeDir, '.claude', 'plugins', 'data', MARKETPLACE_DATA_DIR_NAME);
  }
  return path.join(paths.pluginDataRoot, MARKETPLACE_DATA_DIR_NAME);
}

function isStrictDescendant(base, target) {
  const relative = path.relative(base, target);
  return Boolean(
    relative
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative),
  );
}

/**
 * Canonical form used whenever two roots, or a root and a host path, are
 * compared: follows symlinks (a dotfiles-managed ~/.claude, macOS /var ->
 * /private/var) through the deepest existing ancestor.
 */
function canonicalizeWithExistingAncestor(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(cursor), ...suffix.reverse());
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

module.exports = {
  CONFIG_DIR_ENV,
  INLINE_DATA_DIR_NAME,
  MARKETPLACE_DATA_DIR_NAME,
  MARKETPLACE_NAME,
  PLUGIN_CACHE_DIR_ENV,
  PLUGIN_NAME,
  ClaudePathsError,
  canonicalizeWithExistingAncestor,
  defaultPluginDataDir,
  isStrictDescendant,
  pluginCacheDirRefusal,
  resolveClaudePaths,
  resolveClaudePathsForMutation,
};
