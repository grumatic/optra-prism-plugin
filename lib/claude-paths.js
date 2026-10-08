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

const SCRUB_HINT = 'CLAUDE_CONFIG_DIR is not visible to this command ' +
  '(possibly removed by CLAUDE_CODE_SUBPROCESS_ENV_SCRUB)';

function looksLikeHostPluginData(dataDir) {
  const parts = path.resolve(dataDir).split(path.sep);
  return parts.length >= 3
    && parts[parts.length - 2] === 'data'
    && parts[parts.length - 3] === 'plugins';
}

function absolutePathOrNull(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && path.isAbsolute(value)
    ? value
    : null;
}

/**
 * Cross-checks the running plugin against the current config root: the plugin
 * root and the plugin data directory must sit where Claude Code puts them for
 * this config root. All paths are compared in canonical form.
 *
 *   root strictly inside <cache>/optra-prism/prism -> data <data>/prism-optra-prism
 *   root inside <cache> but outside that           -> refused
 *   root outside <cache>                           -> data <data>/prism-inline
 *                                                     or <data>/prism-optra-prism
 *
 * The third row accepts both names because a local-path marketplace install is
 * loaded in place while its data directory is prism-optra-prism.
 *
 * A missing input is a mismatch for a mutating command and "not-checked" for a
 * read-only report.
 */
function checkPluginContext({ pluginRoot, dataDir, paths, mutating = true } = {}) {
  const result = {
    status: 'mismatch',
    mode: null,
    pluginRoot: pluginRoot || null,
    dataDir: dataDir || null,
    expectedDataDirs: [],
    reason: null,
    hint: null,
  };
  const missing = (reason) => {
    result.status = mutating ? 'mismatch' : 'not-checked';
    result.reason = reason;
    return result;
  };
  if (!absolutePathOrNull(pluginRoot)) return missing('the plugin root is not available');
  if (!dataDir) return missing('the plugin data directory (CLAUDE_PLUGIN_DATA) is not available');
  if (!absolutePathOrNull(dataDir)) {
    result.reason = 'CLAUDE_PLUGIN_DATA must be an absolute path';
    return result;
  }

  let canonical;
  try {
    canonical = {
      pluginRoot: canonicalizeWithExistingAncestor(pluginRoot),
      dataDir: canonicalizeWithExistingAncestor(dataDir),
      cacheRoot: canonicalizeWithExistingAncestor(paths.pluginCacheRoot),
      dataRoot: canonicalizeWithExistingAncestor(paths.pluginDataRoot),
    };
  } catch (error) {
    result.reason = `unable to resolve the plugin install paths: ${error.message}`;
    return result;
  }
  result.pluginRoot = canonical.pluginRoot;
  result.dataDir = canonical.dataDir;

  const ownCache = path.join(canonical.cacheRoot, MARKETPLACE_NAME, PLUGIN_NAME);
  const marketplaceData = path.join(canonical.dataRoot, MARKETPLACE_DATA_DIR_NAME);
  const inlineData = path.join(canonical.dataRoot, INLINE_DATA_DIR_NAME);
  if (isStrictDescendant(ownCache, canonical.pluginRoot)) {
    result.mode = 'marketplace';
    result.expectedDataDirs = [marketplaceData];
  } else if (isStrictDescendant(canonical.cacheRoot, canonical.pluginRoot)) {
    result.reason = `the plugin root is inside the plugin cache but outside ${ownCache}: ` +
      canonical.pluginRoot;
    return result;
  } else {
    result.mode = 'inline';
    result.expectedDataDirs = [inlineData, marketplaceData];
  }

  if (result.expectedDataDirs.includes(canonical.dataDir)) {
    result.status = 'ok';
    return result;
  }
  result.reason = `CLAUDE_PLUGIN_DATA does not match the ${result.mode} plugin root; ` +
    `expected ${result.expectedDataDirs.join(' or ')}`;
  const underOwnDataRoot = isStrictDescendant(paths.pluginDataRoot, path.resolve(dataDir))
    || isStrictDescendant(canonical.dataRoot, canonical.dataDir);
  if (paths.source === 'default' && !underOwnDataRoot && looksLikeHostPluginData(dataDir)) {
    result.hint = SCRUB_HINT;
  }
  return result;
}

function describePluginContext(context) {
  return context.hint ? `${context.reason} (${context.hint})` : context.reason;
}

/**
 * Mutating commands: resolves the config root (refusing an unsupported
 * environment) and requires the plugin context to match it. Throws
 * ClaudePathsError and returns `{ paths, context }` otherwise.
 */
function assertPluginContext({ pluginRoot, dataDir, paths } = {}) {
  const resolved = paths || resolveClaudePathsForMutation();
  const refusal = pluginCacheDirRefusal(resolved);
  if (refusal) throw new ClaudePathsError(refusal);
  const context = checkPluginContext({ pluginRoot, dataDir, paths: resolved, mutating: true });
  if (context.status !== 'ok') throw new ClaudePathsError(describePluginContext(context));
  return { paths: resolved, context };
}

/**
 * Read-only counterpart for status and doctor. Never throws: an unusable
 * CLAUDE_CONFIG_DIR is reported as `error`, and missing inputs come back as
 * "not-checked" instead of a mismatch.
 */
function inspectClaudeContext({ pluginRoot, dataDir, env = process.env, homeDir } = {}) {
  let paths;
  try {
    paths = resolveClaudePaths({ env, homeDir });
  } catch (error) {
    return {
      paths: null,
      error: error && error.message ? error.message : String(error),
      context: null,
      pluginCacheDirEnv: typeof env[PLUGIN_CACHE_DIR_ENV] === 'string' && env[PLUGIN_CACHE_DIR_ENV]
        ? env[PLUGIN_CACHE_DIR_ENV]
        : null,
    };
  }
  return {
    paths,
    error: null,
    context: checkPluginContext({ pluginRoot, dataDir, paths, mutating: false }),
    pluginCacheDirEnv: paths.pluginCacheDirEnv,
  };
}

module.exports = {
  CONFIG_DIR_ENV,
  INLINE_DATA_DIR_NAME,
  MARKETPLACE_DATA_DIR_NAME,
  MARKETPLACE_NAME,
  PLUGIN_CACHE_DIR_ENV,
  PLUGIN_NAME,
  ClaudePathsError,
  assertPluginContext,
  canonicalizeWithExistingAncestor,
  checkPluginContext,
  defaultPluginDataDir,
  describePluginContext,
  inspectClaudeContext,
  isStrictDescendant,
  pluginCacheDirRefusal,
  resolveClaudePaths,
  resolveClaudePathsForMutation,
};
