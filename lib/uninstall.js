/**
 * Deterministic Prism uninstall entrypoint.
 *
 * Preview is read-only. Apply requires the exact, case-sensitive confirmation
 * token and removes only validated Prism-owned targets.
 */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const {
  OTEL_HEADERS_HELPER_KEY,
  OTEL_KEYS,
  PLUGIN_ID,
  buildExpectedOtelEnv,
  helperPathForDataDir,
} = require('./settings');

const MARKETPLACE_NAME = 'optra-prism';
const PLAN_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const PLAN_TOKEN_VERSION = 1;
const PLUGIN_DATA_DIR_BY_MODE = Object.freeze({
  marketplace: 'prism-optra-prism',
  inline: 'prism-inline',
});
const CTA = '👋 Your data is still on the dashboard at https://dashboard.optra-prism.com/ — sign in any time to review past PRISM scores, insights, and coaching history. Reinstall with `/plugin install prism` whenever you want realtime coaching back.';

class UninstallError extends Error {}

function parseArgs(argv) {
  let action = 'preview';
  let index = 0;
  if (argv[0] && !argv[0].startsWith('--')) {
    action = argv[0];
    index = 1;
  }
  if (action !== 'preview' && action !== 'apply') {
    throw new UninstallError(`unknown action: ${action}`);
  }

  const args = {
    action,
    confirmation: null,
    dataDir: null,
    pluginRoot: null,
    projectDir: null,
  };
  const seen = new Set();

  while (index < argv.length) {
    const flag = argv[index++];
    if (flag !== '--confirm'
      && flag !== '--data-dir'
      && flag !== '--plugin-root'
      && flag !== '--project-dir') {
      throw new UninstallError(`unknown argument: ${flag}`);
    }
    if (seen.has(flag)) throw new UninstallError(`duplicate argument: ${flag}`);
    seen.add(flag);
    if (index >= argv.length || !argv[index]) {
      throw new UninstallError(`missing value for ${flag}`);
    }
    const value = argv[index++];
    if (flag === '--confirm') args.confirmation = value;
    else if (flag === '--data-dir') args.dataDir = value;
    else if (flag === '--plugin-root') args.pluginRoot = value;
    else args.projectDir = value;
  }

  if (action === 'preview' && args.confirmation !== null) {
    throw new UninstallError('preview does not accept --confirm');
  }
  if (action === 'apply'
    && (args.confirmation === null || !PLAN_TOKEN_PATTERN.test(args.confirmation))) {
    throw new UninstallError(
      'confirmation rejected; run `/prism:uninstall`, then ' +
        '`/prism:uninstall confirm <plan-token>`',
    );
  }
  return args;
}

function validateDirectory(value, label) {
  if (!value || !path.isAbsolute(value)) {
    throw new UninstallError(`${label} must be a non-empty absolute path`);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new UninstallError(`${label} cannot be the filesystem root`);
  }

  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new UninstallError(`${label} does not exist: ${resolved}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UninstallError(`${label} must be a real directory, not a symlink: ${resolved}`);
  }
  return resolved;
}

function assertSafeDescendant(base, target, label) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new UninstallError(`${label} is outside its allowed root`);
  }

  let cursor = base;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new UninstallError(`${label} contains a symbolic link: ${cursor}`);
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw error;
    }
  }
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

function classifyPluginRoot(pluginRoot, pluginCacheDir) {
  try {
    const canonicalPluginRoot = canonicalizeWithExistingAncestor(pluginRoot);
    const canonicalPluginCacheDir = canonicalizeWithExistingAncestor(pluginCacheDir);
    return isStrictDescendant(canonicalPluginCacheDir, canonicalPluginRoot)
      ? 'marketplace'
      : 'inline';
  } catch {
    return 'unknown';
  }
}

function resolveTargets({
  projectDir,
  dataDir = process.env.CLAUDE_PLUGIN_DATA,
  pluginRoot = process.env.CLAUDE_PLUGIN_ROOT,
} = {}) {
  const homeDir = validateDirectory(os.homedir(), 'home directory');
  const activeProjectDir = validateDirectory(
    projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    'project directory',
  );
  const activePluginRoot = fs.realpathSync(
    validateDirectory(pluginRoot, 'plugin root'),
  );
  const pluginDataRoot = path.join(homeDir, '.claude', 'plugins', 'data');
  const marketplaceCacheDir = path.join(
    homeDir,
    '.claude',
    'plugins',
    'cache',
    MARKETPLACE_NAME,
  );
  const pluginCacheDir = path.join(marketplaceCacheDir, 'prism');
  const installMode = classifyPluginRoot(activePluginRoot, pluginCacheDir);
  if (installMode === 'unknown') {
    throw new UninstallError(
      `unable to bind the plugin root to an install mode: ${activePluginRoot}`,
    );
  }
  const expectedPluginDataDir = path.join(
    pluginDataRoot,
    PLUGIN_DATA_DIR_BY_MODE[installMode],
  );
  const pluginDataDir = dataDir
    ? path.resolve(dataDir)
    : expectedPluginDataDir;
  if (pluginDataDir !== expectedPluginDataDir) {
    throw new UninstallError(
      `CLAUDE_PLUGIN_DATA does not match the ${installMode} plugin root; ` +
        `expected ${expectedPluginDataDir}`,
    );
  }

  const targets = {
    homeDir,
    installMode,
    projectDir: activeProjectDir,
    pluginRoot: activePluginRoot,
    settings: {
      user: path.join(homeDir, '.claude', 'settings.json'),
      project: path.join(activeProjectDir, '.claude', 'settings.json'),
      local: path.join(activeProjectDir, '.claude', 'settings.local.json'),
    },
    installedPlugins: path.join(
      homeDir,
      '.claude',
      'plugins',
      'installed_plugins.json',
    ),
    prismConfigDir: path.join(homeDir, '.prism'),
    pluginDataDir,
    pluginCacheDir,
  };

  for (const [scope, file] of Object.entries(targets.settings)) {
    const base = scope === 'user' ? homeDir : activeProjectDir;
    assertSafeDescendant(base, file, `${scope} settings target`);
  }
  for (const [label, target] of [
    ['installed plugin registry', targets.installedPlugins],
    ['Prism config directory', targets.prismConfigDir],
    ['Prism plugin data directory', targets.pluginDataDir],
    ['Prism plugin cache directory', targets.pluginCacheDir],
  ]) {
    assertSafeDescendant(homeDir, target, label);
  }
  return targets;
}

function readJson(file, label) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new UninstallError(`unable to read ${label} JSON at ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UninstallError(`${label} at ${file} must contain a JSON object`);
  }
  return parsed;
}

function semanticJsonSnapshot(value) {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return `[${value.map((entry) => semanticJsonSnapshot(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${semanticJsonSnapshot(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function readExpectedOtelProjection() {
  try {
    const expected = buildExpectedOtelEnv();
    const otelEnv = expected ? expected.otelEnv : null;
    return {
      otelEnv,
      snapshot: semanticJsonSnapshot(otelEnv),
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return {
      otelEnv: null,
      snapshot: semanticJsonSnapshot({ unavailable: message }),
    };
  }
}

function isPathWithinDirectory(directory, candidate) {
  if (typeof directory !== 'string'
    || typeof candidate !== 'string'
    || !path.isAbsolute(directory)
    || !path.isAbsolute(candidate)) {
    return false;
  }
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function selectOtelHeadersHelper({
  expectedPath,
  pluginDataDir,
  settings = null,
  noSelection = false,
  settingsPreservedForKeptInstall = false,
}) {
  if (noSelection) {
    return {
      expectedPath,
      settingPresent: null,
      decision: 'none',
      reason: 'no-selection',
      referencesPluginData: null,
    };
  }
  if (settingsPreservedForKeptInstall) {
    return {
      expectedPath,
      settingPresent: null,
      decision: 'preserve',
      reason: 'kept-install',
      referencesPluginData: null,
    };
  }
  if (!settings
    || !Object.prototype.hasOwnProperty.call(settings, OTEL_HEADERS_HELPER_KEY)) {
    return {
      expectedPath,
      settingPresent: false,
      decision: 'none',
      reason: 'absent',
      referencesPluginData: false,
    };
  }
  if (settings[OTEL_HEADERS_HELPER_KEY] === expectedPath) {
    return {
      expectedPath,
      settingPresent: true,
      decision: 'remove',
      reason: 'exact-path-match',
      referencesPluginData: true,
    };
  }
  return {
    expectedPath,
    settingPresent: true,
    decision: 'preserve',
    reason: 'value-mismatch',
    referencesPluginData: isPathWithinDirectory(
      pluginDataDir,
      settings[OTEL_HEADERS_HELPER_KEY],
    ),
  };
}

function planTokenAuthority(plan) {
  return {
    version: PLAN_TOKEN_VERSION,
    selection: {
      hasSelection: plan.hasSelection,
      removalKind: plan.removalKind,
      registryEntriesRemoved: plan.registryEntriesRemoved,
      removePrismConfig: plan.removePrismConfig,
      removePluginData: plan.removePluginData,
      removePluginCache: plan.removePluginCache,
      settingsPreservedForKeptInstall: plan.settingsPreservedForKeptInstall,
      otelHeadersHelper: plan.otelHeadersHelper,
    },
    targets: {
      installMode: plan.targets.installMode,
      projectDir: plan.targets.projectDir,
      pluginRoot: plan.targets.pluginRoot,
      pluginDataDir: plan.targets.pluginDataDir,
      pluginCacheDir: plan.targets.pluginCacheDir,
      prismConfigDir: plan.targets.prismConfigDir,
      installedPlugins: plan.targets.installedPlugins,
      settings: plan.targets.settings,
    },
    registry: {
      snapshot: plan.registrySnapshot,
      original: semanticJsonSnapshot(plan.registryOriginalData),
      write: plan.registryWrite
        ? semanticJsonSnapshot(plan.registryWrite.data)
        : null,
    },
    settings: plan.settingsSnapshots.map((input) => ({
      file: input.file,
      scope: input.scope,
      snapshot: input.snapshot,
      write: input.writeSnapshot,
    })),
    otel: {
      projection: plan.otelProjectionSnapshot,
      removedKeys: plan.removedOtelKeys,
      preservedKeys: plan.preservedDivergedOtelKeys,
    },
  };
}

function createPlanToken(plan) {
  return crypto
    .createHash('sha256')
    .update(semanticJsonSnapshot(planTokenAuthority(plan)))
    .digest('hex');
}

function finalizePlan(plan) {
  return {
    ...plan,
    planToken: createPlanToken(plan),
  };
}

function planTokenMatches(plan, candidate) {
  if (!PLAN_TOKEN_PATTERN.test(candidate)) return false;
  const expected = Buffer.from(plan.planToken, 'hex');
  const received = Buffer.from(candidate, 'hex');
  return expected.length === received.length
    && crypto.timingSafeEqual(expected, received);
}

function validateSettings(settings, file) {
  if (!settings) return;
  for (const key of ['env', 'enabledPlugins']) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    const value = settings[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new UninstallError(`"${key}" in ${file} must be a JSON object`);
    }
  }
}

function matchesProject(entry, projectDir) {
  return Boolean(
    entry
      && typeof entry === 'object'
      && typeof entry.projectPath === 'string'
      && path.isAbsolute(entry.projectPath)
      && path.resolve(entry.projectPath) === projectDir,
  );
}

function matchesPluginRoot(entry, pluginRoot) {
  if (!entry || typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) {
    return false;
  }
  try {
    return fs.realpathSync(entry.installPath) === pluginRoot;
  } catch {
    return false;
  }
}

function installModeForEntry(entry, targets) {
  if (!entry || typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) {
    return 'unknown';
  }
  try {
    const stat = fs.lstatSync(entry.installPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unknown';
  } catch {
    return 'unknown';
  }
  return classifyPluginRoot(entry.installPath, targets.pluginCacheDir);
}

function settingsPathForEntry(entry, targets) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.scope === 'user') return targets.settings.user;
  if ((!entry.scope || entry.scope === 'project' || entry.scope === 'local')
    && typeof entry.projectPath === 'string'
    && path.isAbsolute(entry.projectPath)) {
    const name = entry.scope === 'project' ? 'settings.json' : 'settings.local.json';
    return path.join(path.resolve(entry.projectPath), '.claude', name);
  }
  return null;
}

function describeInstall(entry) {
  if (entry && entry.scope === 'user') return '(user scope)';
  if (entry && typeof entry.projectPath === 'string' && entry.projectPath) {
    return entry.projectPath.replace(/[\r\n]/g, '');
  }
  return '(unknown scope)';
}

function buildPlan(options = {}) {
  const targets = resolveTargets(options);
  const expectedOtelHeadersHelperPath = helperPathForDataDir(targets.pluginDataDir);
  const installed = readJson(targets.installedPlugins, 'installed plugin registry');
  const registrySnapshot = semanticJsonSnapshot(installed);
  const registryOriginalData = installed === null
    ? null
    : JSON.parse(JSON.stringify(installed));
  const otelProjection = readExpectedOtelProjection();
  let entries = [];
  if (installed && Object.prototype.hasOwnProperty.call(installed, 'plugins')) {
    if (!installed.plugins
      || typeof installed.plugins !== 'object'
      || Array.isArray(installed.plugins)) {
      throw new UninstallError(
        `"plugins" in ${targets.installedPlugins} must be a JSON object`,
      );
    }
  }
  if (installed && installed.plugins
    && Object.prototype.hasOwnProperty.call(installed.plugins, PLUGIN_ID)) {
    entries = installed.plugins[PLUGIN_ID];
    if (!Array.isArray(entries)) {
      throw new UninstallError(
        `${PLUGIN_ID} in ${targets.installedPlugins} must be an array`,
      );
    }
  }

  const projectEntries = entries.filter((entry) =>
    matchesProject(entry, targets.projectDir)
      && matchesPluginRoot(entry, targets.pluginRoot));
  const hasLocalInstall = projectEntries.some((entry) => !entry.scope || entry.scope === 'local');
  const hasProjectInstall = projectEntries.some((entry) => entry.scope === 'project');
  const hasUserInstall = entries.some((entry) =>
    entry && entry.scope === 'user' && matchesPluginRoot(entry, targets.pluginRoot));
  const removalKind = hasLocalInstall
    ? 'local'
    : (hasProjectInstall ? 'project' : (hasUserInstall ? 'user' : 'none'));
  const keptEntries = entries.filter((entry) => {
    if (removalKind === 'local') {
      return !matchesProject(entry, targets.projectDir)
        || !matchesPluginRoot(entry, targets.pluginRoot)
        || Boolean(entry.scope && entry.scope !== 'local');
    }
    if (removalKind === 'project') {
      return !matchesProject(entry, targets.projectDir)
        || !matchesPluginRoot(entry, targets.pluginRoot)
        || entry.scope !== 'project';
    }
    if (removalKind === 'user') {
      return !entry
        || entry.scope !== 'user'
        || !matchesPluginRoot(entry, targets.pluginRoot);
    }
    return true;
  });
  const remaining = [...new Set(keptEntries.map(describeInstall))];

  let registryEntriesRemoved = 0;
  let registryWrite = null;
  if (installed && keptEntries.length !== entries.length) {
    const before = JSON.stringify(installed);
    if (keptEntries.length === 0) delete installed.plugins[PLUGIN_ID];
    else installed.plugins[PLUGIN_ID] = keptEntries;
    if (JSON.stringify(installed) !== before) {
      registryWrite = { file: targets.installedPlugins, data: installed };
      registryEntriesRemoved = entries.length - keptEntries.length;
    }
  }

  const hasSelection = registryEntriesRemoved > 0 && removalKind !== 'none';
  if (!hasSelection) {
    return finalizePlan({
      targets,
      settingsWrites: [],
      settingsSnapshots: [],
      registryWrite: null,
      registrySnapshot,
      registryOriginalData,
      otelProjectionSnapshot: otelProjection.snapshot,
      hasSelection: false,
      removalKind: 'none',
      registryEntriesRemoved: 0,
      remaining,
      otelTargetScopes: [],
      preservedOtelScopes: [],
      otelScopes: [],
      enabledPluginScopes: [],
      removedOtelKeys: [],
      preservedDivergedOtelKeys: [],
      otelHeadersHelper: selectOtelHeadersHelper({
        expectedPath: expectedOtelHeadersHelperPath,
        pluginDataDir: targets.pluginDataDir,
        noSelection: true,
      }),
      settingsPreservedForKeptInstall: false,
      removePrismConfig: false,
      removePluginData: false,
      removePluginCache: false,
    });
  }

  const preservedOtelScopes = new Set();
  for (const entry of keptEntries) {
    if (entry && entry.scope === 'user') preservedOtelScopes.add('user');
    if (matchesProject(entry, targets.projectDir)
      && (entry.scope === 'project' || entry.scope === 'local')) {
      preservedOtelScopes.add(entry.scope);
    }
  }
  const otelTargetScopes = [removalKind];
  const otelScopes = [];
  const enabledPluginScopes = [];
  const settingsWrites = [];
  const settingsSnapshots = [];
  const removedOtelKeys = [];
  const preservedDivergedOtelKeys = [];
  const settingsFile = targets.settings[removalKind];
  const keptSettingsFiles = new Set(
    keptEntries.map((entry) => settingsPathForEntry(entry, targets)).filter(Boolean),
  );
  const settingsPreservedForKeptInstall = keptSettingsFiles.has(settingsFile);
  const settings = settingsPreservedForKeptInstall
    ? null
    : readJson(settingsFile, `${removalKind} settings`);
  const otelHeadersHelper = selectOtelHeadersHelper({
    expectedPath: expectedOtelHeadersHelperPath,
    pluginDataDir: targets.pluginDataDir,
    settings,
    settingsPreservedForKeptInstall,
  });
  if (!settingsPreservedForKeptInstall) validateSettings(settings, settingsFile);
  if (!settingsPreservedForKeptInstall) {
    settingsSnapshots.push({
      file: settingsFile,
      scope: removalKind,
      snapshot: semanticJsonSnapshot(settings),
      writeSnapshot: null,
    });
  }
  if (settings && !settingsPreservedForKeptInstall) {
    const originalSnapshot = semanticJsonSnapshot(settings);
    if (settings.env) {
      let removedOtel = false;
      for (const key of OTEL_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(settings.env, key)) continue;
        if (otelProjection.otelEnv
          && Object.prototype.hasOwnProperty.call(otelProjection.otelEnv, key)
          && settings.env[key] === otelProjection.otelEnv[key]) {
          delete settings.env[key];
          removedOtel = true;
          removedOtelKeys.push(key);
        } else {
          preservedDivergedOtelKeys.push(key);
        }
      }
      if (Object.keys(settings.env).length === 0) delete settings.env;
      if (removedOtel) otelScopes.push(removalKind);
    }
    if (settings.enabledPlugins
      && Object.prototype.hasOwnProperty.call(settings.enabledPlugins, PLUGIN_ID)) {
      delete settings.enabledPlugins[PLUGIN_ID];
      if (Object.keys(settings.enabledPlugins).length === 0) {
        delete settings.enabledPlugins;
      }
      enabledPluginScopes.push(removalKind);
    }
    if (otelHeadersHelper.decision === 'remove') {
      delete settings[OTEL_HEADERS_HELPER_KEY];
    }
    if (semanticJsonSnapshot(settings) !== originalSnapshot) {
      const writeSnapshot = semanticJsonSnapshot(settings);
      settingsWrites.push({
        file: settingsFile,
        data: settings,
        originalSnapshot,
        scope: removalKind,
      });
      settingsSnapshots[0].writeSnapshot = writeSnapshot;
    }
  }

  const keptInstallModes = keptEntries.map((entry) => installModeForEntry(entry, targets));
  const hasUnknownRemainingMode = keptInstallModes.includes('unknown');
  const hasSameModeRemaining = hasUnknownRemainingMode
    || keptInstallModes.includes(targets.installMode);
  const hasMarketplaceRemaining = hasUnknownRemainingMode
    || keptInstallModes.includes('marketplace');
  const preservedHelperReferencesPluginData = otelHeadersHelper.decision === 'preserve'
    && otelHeadersHelper.referencesPluginData === true;

  return finalizePlan({
    targets,
    settingsWrites,
    settingsSnapshots,
    registryWrite,
    registrySnapshot,
    registryOriginalData,
    otelProjectionSnapshot: otelProjection.snapshot,
    hasSelection,
    removalKind,
    registryEntriesRemoved,
    remaining,
    otelTargetScopes,
    preservedOtelScopes: [...preservedOtelScopes],
    otelScopes: [...new Set(otelScopes)],
    enabledPluginScopes: [...new Set(enabledPluginScopes)],
    removedOtelKeys: [...new Set(removedOtelKeys)].sort(),
    preservedDivergedOtelKeys: [...new Set(preservedDivergedOtelKeys)].sort(),
    otelHeadersHelper,
    settingsPreservedForKeptInstall,
    removePrismConfig: keptEntries.length === 0,
    removePluginData: !hasSameModeRemaining
      && !settingsPreservedForKeptInstall
      && !preservedHelperReferencesPluginData,
    removePluginCache: targets.installMode === 'marketplace' && !hasMarketplaceRemaining,
  });
}

function writeJson(file, data, {
  expectedSnapshot,
  label = 'JSON input',
} = {}) {
  if (expectedSnapshot !== undefined) {
    const current = readJson(file, label);
    if (semanticJsonSnapshot(current) !== expectedSnapshot) {
      throw new UninstallError(`${label} changed before commit`);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.prism-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, {
      flag: 'wx',
      mode,
    });
    if (expectedSnapshot !== undefined) {
      const current = readJson(file, label);
      if (semanticJsonSnapshot(current) !== expectedSnapshot) {
        throw new UninstallError(`${label} changed before commit`);
      }
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function assertSameTargets(plan, currentTargets) {
  const plannedIdentity = {
    homeDir: plan.targets.homeDir,
    installMode: plan.targets.installMode,
    installedPlugins: plan.targets.installedPlugins,
    pluginCacheDir: plan.targets.pluginCacheDir,
    pluginDataDir: plan.targets.pluginDataDir,
    pluginRoot: plan.targets.pluginRoot,
    prismConfigDir: plan.targets.prismConfigDir,
    projectDir: plan.targets.projectDir,
    settings: plan.targets.settings,
  };
  const currentIdentity = {
    homeDir: currentTargets.homeDir,
    installMode: currentTargets.installMode,
    installedPlugins: currentTargets.installedPlugins,
    pluginCacheDir: currentTargets.pluginCacheDir,
    pluginDataDir: currentTargets.pluginDataDir,
    pluginRoot: currentTargets.pluginRoot,
    prismConfigDir: currentTargets.prismConfigDir,
    projectDir: currentTargets.projectDir,
    settings: currentTargets.settings,
  };
  if (semanticJsonSnapshot(plannedIdentity) !== semanticJsonSnapshot(currentIdentity)) {
    throw new UninstallError(
      'uninstall targets changed after planning; cleanup was not applied',
    );
  }
}

function verifyPlanInputs(plan, currentTargets) {
  if (plan.registryWrite.file !== currentTargets.installedPlugins) {
    throw new UninstallError(
      `refusing unexpected registry target: ${plan.registryWrite.file}`,
    );
  }
  const currentRegistry = readJson(
    currentTargets.installedPlugins,
    'installed plugin registry',
  );
  if (semanticJsonSnapshot(currentRegistry) !== plan.registrySnapshot) {
    throw new UninstallError(
      'installed plugin registry changed after planning; cleanup was not applied',
    );
  }

  const currentProjection = readExpectedOtelProjection();
  if (currentProjection.snapshot !== plan.otelProjectionSnapshot) {
    throw new UninstallError(
      'Prism OTEL projection changed after planning; cleanup was not applied',
    );
  }

  for (const input of plan.settingsSnapshots) {
    const expectedSettingsTarget = currentTargets.settings[input.scope];
    if (!expectedSettingsTarget || input.file !== expectedSettingsTarget) {
      throw new UninstallError(`refusing unexpected settings target: ${input.file}`);
    }
    const currentSettings = readJson(input.file, `${input.scope} settings`);
    validateSettings(currentSettings, input.file);
    if (semanticJsonSnapshot(currentSettings) !== input.snapshot) {
      throw new UninstallError(
        `${input.scope} settings changed after planning; cleanup was not applied`,
      );
    }
  }
}

function validateCleanupTarget(plan, target, label, scope = null) {
  const base = scope === 'user'
    ? validateDirectory(plan.targets.homeDir, 'home directory')
    : (scope
      ? validateDirectory(plan.targets.projectDir, 'project directory')
      : validateDirectory(plan.targets.homeDir, 'home directory'));
  assertSafeDescendant(base, target, label);
}

function assertRegistryStillCommitted(plan, currentTargets) {
  const currentRegistry = readJson(
    currentTargets.installedPlugins,
    'installed plugin registry',
  );
  const committedSnapshot = semanticJsonSnapshot(plan.registryWrite.data);
  if (semanticJsonSnapshot(currentRegistry) !== committedSnapshot) {
    throw new UninstallError(
      'installed plugin registry changed after commit; destructive cleanup was skipped',
    );
  }
}

function rollbackRegistryAfterSettingsFailure(
  plan,
  currentTargets,
  writeJsonFn,
  settingsError,
) {
  const settingsMessage = settingsError && settingsError.message
    ? settingsError.message
    : String(settingsError);
  try {
    assertRegistryStillCommitted(plan, currentTargets);
    writeJsonFn(
      plan.registryWrite.file,
      plan.registryOriginalData,
      {
        expectedSnapshot: semanticJsonSnapshot(plan.registryWrite.data),
        label: 'committed installed plugin registry',
      },
    );
    const restored = readJson(
      currentTargets.installedPlugins,
      'restored installed plugin registry',
    );
    if (semanticJsonSnapshot(restored) !== plan.registrySnapshot) {
      throw new UninstallError('registry rollback did not restore the original snapshot');
    }
  } catch (rollbackError) {
    const rollbackMessage = rollbackError && rollbackError.message
      ? rollbackError.message
      : String(rollbackError);
    throw new UninstallError(
      'settings cleanup failed after registry commit and automatic registry rollback ' +
        'was unsafe or failed. No shared config, data, or cache cleanup was attempted. ' +
        `Manual cleanup is required. Settings error: ${settingsMessage}. ` +
        `Rollback error: ${rollbackMessage}`,
    );
  }
  throw new UninstallError(
    'settings cleanup failed after registry commit; the original installed plugin ' +
      'registry was restored and no shared config, data, or cache cleanup was attempted. ' +
      `Retry uninstall after resolving the settings error: ${settingsMessage}`,
  );
}

function applyPlan(plan, {
  writeJsonFn = writeJson,
  removePathFn = (target) => fs.rmSync(target, { recursive: true, force: true }),
  beforeCommitFn = null,
  afterRegistryCommitFn = null,
} = {}) {
  if (!plan.hasSelection || !plan.registryWrite) {
    throw new UninstallError(
      'no exact Prism install entry matches this project or user scope; cleanup was not applied',
    );
  }
  const targetOptions = {
    projectDir: plan.targets.projectDir,
    dataDir: plan.targets.pluginDataDir,
    pluginRoot: plan.targets.pluginRoot,
  };
  let currentTargets = resolveTargets(targetOptions);
  assertSameTargets(plan, currentTargets);
  verifyPlanInputs(plan, currentTargets);

  if (beforeCommitFn) beforeCommitFn();

  // Re-resolve every target and re-read every deletion-authority input at the
  // last possible point before the authoritative registry commit.
  currentTargets = resolveTargets(targetOptions);
  assertSameTargets(plan, currentTargets);
  verifyPlanInputs(plan, currentTargets);
  writeJsonFn(plan.registryWrite.file, plan.registryWrite.data, {
    expectedSnapshot: plan.registrySnapshot,
    label: 'installed plugin registry',
  });

  if (afterRegistryCommitFn) afterRegistryCommitFn();

  const removedShared = [];
  const settingsCleanedScopes = [];
  const warnings = [];
  const leftovers = [];
  if (plan.preservedDivergedOtelKeys.length > 0) {
    warnings.push(
      'OTEL values were preserved because they do not exactly match the current ' +
        `Prism projection: ${plan.preservedDivergedOtelKeys.join(', ')}`,
    );
  }
  if (plan.otelHeadersHelper.reason === 'value-mismatch') {
    warnings.push(
      `${OTEL_HEADERS_HELPER_KEY} was preserved because its value does not exactly match ` +
        `the expected Prism helper path: ${plan.otelHeadersHelper.expectedPath}`,
    );
  }

  for (const write of plan.settingsWrites) {
    try {
      validateCleanupTarget(
        plan,
        write.file,
        `${write.scope} settings target`,
        write.scope,
      );
      const currentProjection = readExpectedOtelProjection();
      if (currentProjection.snapshot !== plan.otelProjectionSnapshot) {
        throw new UninstallError('Prism OTEL projection changed after registry commit');
      }
      const currentSettings = readJson(write.file, `${write.scope} settings`);
      validateSettings(currentSettings, write.file);
      if (semanticJsonSnapshot(currentSettings) !== write.originalSnapshot) {
        throw new UninstallError(`${write.scope} settings changed after registry commit`);
      }
      assertRegistryStillCommitted(plan, currentTargets);
      writeJsonFn(write.file, write.data, {
        expectedSnapshot: write.originalSnapshot,
        label: `${write.scope} settings`,
      });
      settingsCleanedScopes.push(write.scope);
    } catch (error) {
      rollbackRegistryAfterSettingsFailure(
        plan,
        currentTargets,
        writeJsonFn,
        error,
      );
    }
  }

  for (const [enabled, label, target] of [
    [plan.removePrismConfig, 'Prism config', currentTargets.prismConfigDir],
    [plan.removePluginData, 'Prism plugin data', currentTargets.pluginDataDir],
  ]) {
    if (enabled) {
      try {
        validateCleanupTarget(plan, target, `${label} target`);
        assertRegistryStillCommitted(plan, currentTargets);
        if (!fs.existsSync(target)) continue;
        removePathFn(target);
        removedShared.push(label);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        leftovers.push({ label, path: target, error: message });
      }
    }
  }

  if (plan.removePluginCache) {
    try {
      validateCleanupTarget(
        plan,
        currentTargets.pluginCacheDir,
        'Prism plugin cache target',
      );
      assertRegistryStillCommitted(plan, currentTargets);
      if (fs.existsSync(currentTargets.pluginCacheDir)) {
        removePathFn(currentTargets.pluginCacheDir);
        removedShared.push('Prism plugin cache');
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      leftovers.push({
        label: 'Prism plugin cache',
        path: currentTargets.pluginCacheDir,
        error: message,
      });
    }
  }
  return {
    removedShared,
    settingsCleanedScopes,
    warnings,
    leftovers,
    otelHeadersHelper: {
      ...plan.otelHeadersHelper,
      removed: plan.otelHeadersHelper.decision === 'remove'
        && settingsCleanedScopes.includes(plan.removalKind),
      preserved: plan.otelHeadersHelper.decision === 'preserve',
    },
  };
}

function appendRemaining(lines, remaining) {
  for (const install of remaining) lines.push(`  - ${install}`);
}

function scopeNames(scopes) {
  return scopes.map((scope) => (scope === 'local' ? 'project-local' : scope)).join(', ');
}

function renderPreview(plan) {
  if (!plan.hasSelection) {
    const lines = [
      'Prism uninstall preview',
      '',
      'No files were changed.',
      '',
      'Cleanup is blocked because no exact Prism install entry matches this project or user scope.',
      'No settings, registry entries, shared config, plugin data, or cache will be removed.',
    ];
    if (plan.remaining.length > 0) {
      lines.push('Other registered Prism installs were left untouched:');
      appendRemaining(lines, plan.remaining);
    }
    lines.push(`The marketplace registration (${MARKETPLACE_NAME}) will be preserved.`);
    return `${lines.join('\n')}\n`;
  }

  const lines = [
    'Prism uninstall preview',
    '',
    'No files were changed.',
    '',
    'On confirmation, Prism will:',
  ];
  if (plan.settingsPreservedForKeptInstall) {
    lines.push('- Preserve the shared settings file because a remaining Prism install still uses it.');
  } else if (plan.removedOtelKeys.length > 0) {
    lines.push(
      `- Remove ${plan.removedOtelKeys.length} OTEL values that exactly match the current ` +
        `Prism projection from ${scopeNames(plan.otelTargetScopes)} settings.`,
    );
  } else {
    lines.push('- Preserve OTEL values because none exactly match the current Prism projection.');
  }
  if (plan.preservedDivergedOtelKeys.length > 0) {
    lines.push(
      '- Preserve diverged or unverified OTEL values: ' +
        `${plan.preservedDivergedOtelKeys.join(', ')}.`,
    );
  }
  if (plan.otelHeadersHelper.reason === 'kept-install') {
    lines.push(
      `- Preserve ${OTEL_HEADERS_HELPER_KEY} with the entire shared settings file; ` +
        'its value will not be inspected.',
    );
  } else if (plan.otelHeadersHelper.decision === 'remove') {
    lines.push(
      `- Remove ${OTEL_HEADERS_HELPER_KEY} because it exactly matches the expected ` +
        `Prism helper path at ${plan.otelHeadersHelper.expectedPath}.`,
    );
  } else if (plan.otelHeadersHelper.decision === 'preserve') {
    lines.push(
      `- Preserve ${OTEL_HEADERS_HELPER_KEY} because its value does not exactly match ` +
        `the expected Prism helper path at ${plan.otelHeadersHelper.expectedPath}.`,
    );
  } else {
    lines.push(`- No ${OTEL_HEADERS_HELPER_KEY} setting is present in the selected settings file.`);
  }
  if (plan.removalKind === 'local') {
    lines.push(`- Remove the Prism local-scope install entry for ${plan.targets.projectDir}.`);
  } else if (plan.removalKind === 'project') {
    lines.push(`- Remove the Prism project-scope install entry for ${plan.targets.projectDir}.`);
  } else if (plan.removalKind === 'user') {
    lines.push('- Remove the Prism user-scope install entry.');
  } else {
    lines.push('- No matching installed_plugins.json entry was found for this scope.');
  }
  if (plan.enabledPluginScopes.length > 0) {
    lines.push('- Remove the current scope enabledPlugins registration.');
  }
  if (plan.preservedOtelScopes.length > 0) {
    lines.push(
      `- Preserve the ${scopeNames(plan.preservedOtelScopes)} OTEL projection because matching installs remain.`,
    );
  }

  if (plan.removePrismConfig) {
    lines.push(`- Remove shared Prism config at ${plan.targets.prismConfigDir}.`);
  } else {
    lines.push(`- Preserve shared Prism config at ${plan.targets.prismConfigDir}.`);
  }
  if (plan.removePluginData) {
    lines.push(`- Remove ${plan.targets.installMode} plugin data at ${plan.targets.pluginDataDir}.`);
  } else {
    const preservationReason = plan.settingsPreservedForKeptInstall
      ? 'because a preserved settings file may still reference it.'
      : plan.otelHeadersHelper.decision === 'preserve'
        && plan.otelHeadersHelper.referencesPluginData === true
        ? `because the preserved ${OTEL_HEADERS_HELPER_KEY} setting still references it.`
        : 'because a same-mode or unclassified install remains.';
    lines.push(
      `- Preserve ${plan.targets.installMode} plugin data at ${plan.targets.pluginDataDir} ` +
        preservationReason,
    );
  }
  if (plan.removePluginCache) {
    lines.push(`- Remove the exact Prism plugin cache at ${plan.targets.pluginCacheDir}.`);
  } else if (plan.targets.installMode === 'marketplace') {
    lines.push(
      `- Preserve the exact Prism plugin cache at ${plan.targets.pluginCacheDir} ` +
        'because a marketplace or unclassified install remains.',
    );
  } else {
    lines.push('- Preserve the marketplace cache because this is an inline plugin install.');
  }
  if (plan.remaining.length > 0) {
    lines.push('- Preserve these remaining Prism installs:');
    appendRemaining(lines, plan.remaining);
  }
  lines.push(
    `- Preserve the ${MARKETPLACE_NAME} marketplace registration.`,
    '',
    `Plan token: ${plan.planToken}`,
    `Run \`/prism:uninstall confirm ${plan.planToken}\` to apply this exact plan.`,
  );
  return `${lines.join('\n')}\n`;
}

function renderApplied(plan, result) {
  const leftovers = result.leftovers || [];
  const lines = [
    leftovers.length > 0
      ? 'Prism plugin registration removed for this scope, but artifact cleanup is incomplete.'
      : 'Prism plugin uninstalled for this scope.',
  ];
  const cleanedScopes = new Set(result.settingsCleanedScopes || []);
  if (plan.settingsPreservedForKeptInstall) {
    lines.push('The shared settings file was preserved for a remaining Prism install.');
  } else if (plan.otelScopes.some((scope) => cleanedScopes.has(scope))) {
    lines.push(`OTEL settings cleaned: ${scopeNames(plan.otelScopes)}.`);
  } else if (plan.otelScopes.length > 0) {
    lines.push('Prism-owned OTEL settings were left in place after registry removal.');
  } else if (plan.preservedDivergedOtelKeys.length > 0) {
    lines.push('OTEL settings were preserved because Prism ownership could not be proven.');
  } else {
    lines.push('No Prism-managed OTEL settings were present.');
  }
  if (plan.preservedOtelScopes.length > 0) {
    lines.push(
      `OTEL projection preserved for remaining installs: ${scopeNames(plan.preservedOtelScopes)}.`,
    );
  }
  const otelHeadersHelper = result.otelHeadersHelper || {};
  if (otelHeadersHelper.removed) {
    lines.push(
      `${OTEL_HEADERS_HELPER_KEY} removed after exact path match: ` +
        `${plan.otelHeadersHelper.expectedPath}.`,
    );
  } else if (plan.otelHeadersHelper.reason === 'kept-install') {
    lines.push(
      `${OTEL_HEADERS_HELPER_KEY} was not inspected or removed because the entire shared ` +
        'settings file was preserved.',
    );
  } else if (otelHeadersHelper.preserved) {
    lines.push(
      `${OTEL_HEADERS_HELPER_KEY} preserved because it did not exactly match the expected ` +
        `Prism helper path: ${plan.otelHeadersHelper.expectedPath}.`,
    );
  } else {
    lines.push(`No ${OTEL_HEADERS_HELPER_KEY} setting was present.`);
  }
  if (plan.registryEntriesRemoved > 0) {
    lines.push(`Installed plugin registry entries removed: ${plan.registryEntriesRemoved}.`);
  } else {
    lines.push('No matching installed plugin registry entry was present.');
  }
  if (plan.settingsPreservedForKeptInstall) {
    lines.push('The shared enabledPlugins registration was preserved.');
  } else if (plan.enabledPluginScopes.some((scope) => cleanedScopes.has(scope))) {
    lines.push(`enabledPlugins cleaned: ${plan.enabledPluginScopes.join(', ')}.`);
  } else if (plan.enabledPluginScopes.length > 0) {
    lines.push('The enabledPlugins registration was left in place after registry removal.');
  } else {
    lines.push('No matching enabledPlugins registration was present.');
  }

  if (plan.remaining.length > 0) {
    lines.push('Prism remains installed in:');
    appendRemaining(lines, plan.remaining);
  }
  if (result.removedShared.length > 0) {
    lines.push(`Shared artifacts removed: ${result.removedShared.join(', ')}.`);
  } else if (leftovers.length === 0) {
    lines.push('No selected Prism config, data, or cache target was removed.');
  }
  if (leftovers.length > 0) {
    lines.push('Artifact cleanup is incomplete.');
    for (const leftover of leftovers) {
      lines.push(
        `Leftover: ${leftover.label} at ${leftover.path}. Reason: ${leftover.error}`,
      );
    }
    lines.push(
      'Manual cleanup required: verify that no Prism install uses each path above, ' +
        'then remove only those exact paths.',
    );
  }
  for (const warning of result.warnings || []) {
    lines.push(`Warning: ${warning}`);
  }

  lines.push(
    `The marketplace registration (${MARKETPLACE_NAME}) was preserved.`,
    'Restart Claude Code to complete removal.',
    '',
    CTA,
  );
  return `${lines.join('\n')}\n`;
}

function resultExitCode(result) {
  return Array.isArray(result.leftovers) && result.leftovers.length > 0 ? 2 : 0;
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const plan = buildPlan({
      projectDir: args.projectDir,
      dataDir: args.dataDir || undefined,
      pluginRoot: args.pluginRoot || undefined,
    });
    if (args.action === 'preview') {
      process.stdout.write(renderPreview(plan));
      return 0;
    }
    if (!planTokenMatches(plan, args.confirmation)) {
      throw new UninstallError(
        'uninstall plan token does not match the current scope, registry, settings, ' +
          'or cleanup targets; run `/prism:uninstall` again',
      );
    }
    const result = applyPlan(plan);
    process.stdout.write(renderApplied(plan, result));
    return resultExitCode(result);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`[prism:uninstall] ERROR: ${message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  MARKETPLACE_NAME,
  PLAN_TOKEN_PATTERN,
  UninstallError,
  applyPlan,
  buildPlan,
  createPlanToken,
  main,
  parseArgs,
  planTokenMatches,
  renderApplied,
  renderPreview,
  resultExitCode,
  resolveTargets,
};
