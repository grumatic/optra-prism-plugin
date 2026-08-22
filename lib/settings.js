/**
 * Reads Claude Code settings and writes Prism OTEL settings to the plugin's
 * installed scope.
 *
 * Scope mapping:
 *   user    -> ~/.claude/settings.json
 *   project -> <project>/.claude/settings.json
 *   local   -> <project>/.claude/settings.local.json
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasApiKey } = require('./api-key');
const { verifyBinding } = require('./binding');
const { getConfig, isSupportedIngestUrl } = require('./config');
const { buildOtelHeaders, readPluginVersion } = require('./plugin-version');

const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const INSTALLED_PLUGINS = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const PLUGIN_ID = 'prism@optra-prism';
const OTEL_HEADERS_HELPER_KEY = 'otelHeadersHelper';
const OTEL_HEADERS_HELPER_FILENAME = 'prism-otel-headers-helper.js';
const OTEL_HEADERS_HELPER_SOURCE = path.join(__dirname, 'otel-headers-helper.js');
const OTEL_HEADERS_HELPER_MODE = 0o700;
const SETTINGS_CAS_ATTEMPTS = 3;
const SETTINGS_LOCK_WAIT_MS = 10;
const SETTINGS_LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const LEGACY_ASSISTANT_RESPONSES_KEY = 'OTEL_LOG_ASSISTANT_RESPONSES';
const LEGACY_ASSISTANT_RESPONSES_VALUE = '0';

// Includes the current projection plus legacy Prism keys that cleanup must remove.
const OTEL_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_BLRP_MAX_EXPORT_BATCH_SIZE',
  'OTEL_BLRP_SCHEDULE_DELAY',
];
// Frozen: a key added to the projection later must never be added here, or an upgrading install could never satisfy legacy ownership.
const LEGACY_PROJECTION_OWNERSHIP_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_TOOL_DETAILS',
];
const INSTALL_SCOPES = ['user', 'project', 'local'];

function scopeRank(scope) {
  const index = INSTALL_SCOPES.indexOf(scope);
  return index === -1 ? null : index;
}

function resolveProjectDir(projectDir) {
  return projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function projectSettingsPath(projectDir) {
  return path.join(resolveProjectDir(projectDir), '.claude', 'settings.json');
}

function localSettingsPath(projectDir) {
  return path.join(resolveProjectDir(projectDir), '.claude', 'settings.local.json');
}

function pathForScope(scope, projectDir) {
  if (scope === 'user') return USER_SETTINGS;
  if (scope === 'project') return projectSettingsPath(projectDir);
  if (scope === 'local') return localSettingsPath(projectDir);
  throw new Error(`unknown scope: ${scope}`);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error(`Unable to read JSON from ${file}: ${error.message}`);
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeFileAtomic(file, contents, mode) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempFile, contents, { mode, flag: 'wx' });
    fs.renameSync(tempFile, file);
    if (mode !== undefined) fs.chmodSync(file, mode);
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function readSettingsSnapshot(file) {
  let settings;
  let exists = true;
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TypeError(`Settings target must be a regular file that is not a symlink: ${file}`);
    }
    settings = readSettings(file);
    mode = stat.mode & 0o777;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    settings = {};
    exists = false;
  }
  return {
    settings,
    signature: {
      exists,
      mode,
      semantic: canonicalJson(settings),
    },
  };
}

function snapshotsMatch(left, right) {
  return left.exists === right.exists
    && left.mode === right.mode
    && left.semantic === right.semantic;
}

function settingsLockPath(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.prism.lock`);
}

function removeDeadSettingsLock(lockFile) {
  let stat;
  let record;
  try {
    stat = fs.lstatSync(lockFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return false;
  }
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return false;

  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    if (!error || error.code !== 'ESRCH') return false;
  }

  try {
    const current = fs.lstatSync(lockFile);
    if (current.dev !== stat.dev || current.ino !== stat.ino) return false;
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

function acquireSettingsLock(file) {
  const lockFile = settingsLockPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < SETTINGS_CAS_ATTEMPTS; attempt++) {
    const token = crypto.randomUUID();
    let descriptor;
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
      return { descriptor, lockFile, token };
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(lockFile); } catch {}
      }
      if (!error || error.code !== 'EEXIST') throw error;
      if (removeDeadSettingsLock(lockFile)) continue;
      if (attempt + 1 < SETTINGS_CAS_ATTEMPTS) {
        Atomics.wait(SETTINGS_LOCK_WAIT_BUFFER, 0, 0, SETTINGS_LOCK_WAIT_MS);
      }
    }
  }
  return null;
}

function releaseSettingsLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.descriptor); } catch {}
  try {
    const record = JSON.parse(fs.readFileSync(lock.lockFile, 'utf8'));
    if (record && record.token === lock.token) fs.unlinkSync(lock.lockFile);
  } catch {}
}

function writeJsonAtomicCas(file, data, expectedSignature) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, {
      mode: expectedSignature.mode,
      flag: 'wx',
    });

    let current;
    try {
      current = readSettingsSnapshot(file);
    } catch {
      return false;
    }
    if (!snapshotsMatch(current.signature, expectedSignature)) return false;

    fs.renameSync(tempFile, file);
    fs.chmodSync(file, expectedSignature.mode);
    return true;
  } finally {
    try { fs.unlinkSync(tempFile); } catch {}
  }
}

function updateSettingsAtomic(file, project) {
  let lock;
  try {
    lock = acquireSettingsLock(file);
  } catch (error) {
    return { ok: false, changed: false, reason: `unable to lock settings: ${error.message}` };
  }
  if (!lock) return { ok: false, changed: false, reason: 'settings update is locked' };

  try {
    for (let attempt = 0; attempt < SETTINGS_CAS_ATTEMPTS; attempt++) {
      let snapshot;
      try {
        snapshot = readSettingsSnapshot(file);
      } catch (error) {
        return {
          ok: false,
          reason: `unable to read settings safely: ${error.message}`,
        };
      }

      const proposal = project(snapshot.settings);
      if (!proposal.changed) return { ok: true, ...proposal };
      if (writeJsonAtomicCas(file, proposal.settings, snapshot.signature)) {
        return { ok: true, ...proposal };
      }
    }

    return {
      ok: false,
      changed: false,
      reason: 'settings changed concurrently',
    };
  } finally {
    releaseSettingsLock(lock);
  }
}

function readSettings(file) {
  const settings = readJson(file) || {};
  if (Object.prototype.hasOwnProperty.call(settings, 'env')) {
    const env = settings.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      throw new Error(`Expected "env" in ${file} to be a JSON object`);
    }
  }
  return settings;
}

/**
 * Merge settings env values in Claude Code precedence order. Each own key in
 * a later layer replaces the value and source from the previous layer.
 */
function readEffectiveSettings(projectDir) {
  const files = {
    user: USER_SETTINGS,
    project: projectSettingsPath(projectDir),
    local: localSettingsPath(projectDir),
  };
  const env = Object.create(null);
  const sources = Object.create(null);

  for (const scope of ['user', 'project', 'local']) {
    const settings = readSettings(files[scope]);
    const layerEnv = settings.env || {};
    for (const key of Object.keys(layerEnv)) {
      env[key] = layerEnv[key];
      sources[key] = scope;
    }
  }

  return { env: { ...env }, sources: { ...sources }, files };
}

function readEffectiveSetting(key, projectDir) {
  const files = {
    user: USER_SETTINGS,
    project: projectSettingsPath(projectDir),
    local: localSettingsPath(projectDir),
  };
  let value;
  let source = null;
  for (const scope of ['user', 'project', 'local']) {
    const settings = readSettings(files[scope]);
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      value = settings[key];
      source = scope;
    }
  }
  return { value, source, files };
}

function helperPathForDataDir(dataDir) {
  if (typeof dataDir !== 'string'
    || dataDir.length === 0
    || dataDir.includes('\0')
    || !path.isAbsolute(dataDir)) {
    throw new TypeError('CLAUDE_PLUGIN_DATA must be an absolute path');
  }
  return path.join(path.resolve(dataDir), 'bin', OTEL_HEADERS_HELPER_FILENAME);
}

function readPathState(file, type) {
  const state = {
    exists: false,
    notSymlink: null,
    matchesType: null,
    stat: null,
    error: null,
  };
  try {
    const stat = fs.lstatSync(file);
    state.exists = true;
    state.notSymlink = !stat.isSymbolicLink();
    state.matchesType = type === 'directory' ? stat.isDirectory() : stat.isFile();
    state.stat = stat;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return state;
    state.error = error.message;
  }
  return state;
}

function isCanonicalChild(parent, child) {
  const relative = path.relative(parent, child);
  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/**
 * Read-only inspection of the exact Prism-managed helper artifact. This never
 * executes the configured or expected helper.
 */
function inspectManagedOtelHeadersHelper(dataDir) {
  const result = {
    expectedPath: null,
    expectedPathError: null,
    exists: false,
    regularFile: null,
    notSymlink: null,
    safePath: false,
    ownedByCurrentUser: null,
    exactMode: null,
    executable: null,
    matchesBundledSource: null,
    dataDirExists: false,
    dataDirDirectory: null,
    dataDirNotSymlink: null,
    binDirExists: false,
    binDirDirectory: null,
    binDirNotSymlink: null,
    ok: false,
    reason: null,
  };

  let helperPath;
  try {
    helperPath = helperPathForDataDir(dataDir);
    result.expectedPath = helperPath;
  } catch (error) {
    result.expectedPathError = error.message;
    result.reason = error.message;
    return result;
  }

  const resolvedDataDir = path.resolve(dataDir);
  const binDir = path.dirname(helperPath);
  const dataState = readPathState(resolvedDataDir, 'directory');
  const binState = readPathState(binDir, 'directory');
  const helperState = readPathState(helperPath, 'file');

  result.dataDirExists = dataState.exists;
  result.dataDirDirectory = dataState.matchesType;
  result.dataDirNotSymlink = dataState.notSymlink;
  result.binDirExists = binState.exists;
  result.binDirDirectory = binState.matchesType;
  result.binDirNotSymlink = binState.notSymlink;
  result.exists = helperState.exists;
  result.regularFile = helperState.matchesType;
  result.notSymlink = helperState.notSymlink;

  const errors = [dataState.error, binState.error, helperState.error].filter(Boolean);
  let canonicalDataDir = null;
  let canonicalBinDir = null;
  let canonicalHelper = null;
  if (dataState.exists && dataState.matchesType && dataState.notSymlink) {
    try { canonicalDataDir = fs.realpathSync(resolvedDataDir); } catch (error) {
      errors.push(error.message);
    }
  }
  if (binState.exists && binState.matchesType && binState.notSymlink) {
    try { canonicalBinDir = fs.realpathSync(binDir); } catch (error) {
      errors.push(error.message);
    }
  }
  if (helperState.exists && helperState.matchesType && helperState.notSymlink) {
    try { canonicalHelper = fs.realpathSync(helperPath); } catch (error) {
      errors.push(error.message);
    }
  }

  result.safePath = path.isAbsolute(helperPath)
    && canonicalDataDir !== null
    && canonicalBinDir !== null
    && canonicalHelper !== null
    && isCanonicalChild(canonicalDataDir, canonicalBinDir)
    && path.dirname(canonicalBinDir) === canonicalDataDir
    && isCanonicalChild(canonicalBinDir, canonicalHelper)
    && path.dirname(canonicalHelper) === canonicalBinDir
    && path.basename(canonicalHelper) === OTEL_HEADERS_HELPER_FILENAME;

  if (helperState.exists && helperState.matchesType && helperState.notSymlink) {
    const uidSupported = typeof process.getuid === 'function'
      && Number.isInteger(helperState.stat.uid);
    result.ownedByCurrentUser = uidSupported
      ? helperState.stat.uid === process.getuid()
      : true;
    result.exactMode = (helperState.stat.mode & 0o777) === OTEL_HEADERS_HELPER_MODE;
    try {
      fs.accessSync(helperPath, fs.constants.X_OK);
      result.executable = true;
    } catch {
      result.executable = false;
    }
    try {
      result.matchesBundledSource = fs.readFileSync(helperPath)
        .equals(fs.readFileSync(OTEL_HEADERS_HELPER_SOURCE));
    } catch (error) {
      result.matchesBundledSource = false;
      errors.push(error.message);
    }
  }

  result.ok = result.exists
    && result.regularFile === true
    && result.notSymlink === true
    && result.safePath
    && result.ownedByCurrentUser === true
    && result.exactMode === true
    && result.executable === true
    && result.matchesBundledSource === true;

  if (!result.ok) {
    if (errors.length > 0) result.reason = errors.join('; ');
    else if (!result.dataDirExists) result.reason = 'plugin data directory does not exist';
    else if (!result.dataDirNotSymlink || !result.dataDirDirectory) {
      result.reason = 'plugin data path is not a safe directory';
    } else if (!result.binDirExists) result.reason = 'helper bin directory does not exist';
    else if (!result.binDirNotSymlink || !result.binDirDirectory) {
      result.reason = 'helper bin path is not a safe directory';
    } else if (!result.exists) result.reason = 'managed helper does not exist';
    else if (!result.notSymlink || !result.regularFile) {
      result.reason = 'managed helper is not a regular non-symlink file';
    } else if (!result.safePath) result.reason = 'managed helper escapes its canonical data directory';
    else if (!result.ownedByCurrentUser) result.reason = 'managed helper is not owned by the current user';
    else if (!result.exactMode) result.reason = 'managed helper mode is not 0700';
    else if (!result.executable) result.reason = 'managed helper is not executable';
    else if (!result.matchesBundledSource) result.reason = 'managed helper differs from bundled source';
  }
  return result;
}

function ensureSafeDirectory(directory, label, recursive) {
  let state = readPathState(directory, 'directory');
  if (!state.exists) {
    fs.mkdirSync(directory, { recursive, mode: 0o700 });
    state = readPathState(directory, 'directory');
  }
  if (state.error) throw new TypeError(`${label} cannot be inspected: ${state.error}`);
  if (!state.notSymlink || !state.matchesType) {
    throw new TypeError(`${label} must be a non-symlink directory`);
  }
  return fs.realpathSync(directory);
}

function installOtelHeadersHelper(dataDir) {
  const helperPath = helperPathForDataDir(dataDir);
  const resolvedDataDir = path.resolve(dataDir);
  const binDir = path.dirname(helperPath);
  const canonicalDataDir = ensureSafeDirectory(resolvedDataDir, 'CLAUDE_PLUGIN_DATA', true);
  const canonicalBinDir = ensureSafeDirectory(binDir, 'OTEL headers helper bin', false);
  if (path.dirname(canonicalBinDir) !== canonicalDataDir
    || !isCanonicalChild(canonicalDataDir, canonicalBinDir)) {
    throw new TypeError('OTEL headers helper bin must remain inside CLAUDE_PLUGIN_DATA');
  }

  const source = fs.readFileSync(OTEL_HEADERS_HELPER_SOURCE);
  const helperState = readPathState(helperPath, 'file');
  if (helperState.error) {
    throw new TypeError(`OTEL headers helper target cannot be inspected: ${helperState.error}`);
  }
  if (helperState.exists
    && (!helperState.matchesType || !helperState.notSymlink)) {
    throw new TypeError('OTEL headers helper target must be a regular file that is not a symlink');
  }
  if (helperState.exists
    && typeof process.getuid === 'function'
    && Number.isInteger(helperState.stat.uid)
    && helperState.stat.uid !== process.getuid()) {
    throw new TypeError('OTEL headers helper target must be owned by the current user');
  }

  const current = helperState.exists ? fs.readFileSync(helperPath) : null;
  if (!current || !current.equals(source)) {
    writeFileAtomic(helperPath, source, OTEL_HEADERS_HELPER_MODE);
  } else if ((helperState.stat.mode & 0o777) !== OTEL_HEADERS_HELPER_MODE) {
    fs.chmodSync(helperPath, OTEL_HEADERS_HELPER_MODE);
  }

  const inspected = inspectManagedOtelHeadersHelper(dataDir);
  if (!inspected.ok) {
    throw new TypeError(`OTEL headers helper installation is unsafe: ${inspected.reason}`);
  }
  return helperPath;
}

function canProjectHelper(settings, helperPath) {
  return !Object.prototype.hasOwnProperty.call(settings, OTEL_HEADERS_HELPER_KEY)
    || settings[OTEL_HEADERS_HELPER_KEY] === helperPath;
}

function projectManagedHelper(settings, projectDir, dataDir) {
  const helperPath = helperPathForDataDir(dataDir);
  const effectiveBefore = readEffectiveSetting(OTEL_HEADERS_HELPER_KEY, projectDir);
  const effectiveConflict = effectiveBefore.value !== undefined
    && effectiveBefore.value !== helperPath;
  const targetCompatible = canProjectHelper(settings, helperPath);
  let helperSettingChanged = false;
  let helperArtifactChanged = false;

  // Preserve an unrelated disk-effective helper. If the managed path is
  // already effective from another layer, repair its artifact without
  // overwriting an unrelated value hidden in this target layer.
  if (!effectiveConflict && (targetCompatible || effectiveBefore.value === helperPath)) {
    const before = inspectManagedOtelHeadersHelper(dataDir);
    installOtelHeadersHelper(dataDir);
    helperArtifactChanged = !before.ok;
    if (targetCompatible && settings[OTEL_HEADERS_HELPER_KEY] !== helperPath) {
      settings[OTEL_HEADERS_HELPER_KEY] = helperPath;
      helperSettingChanged = true;
    }
  }

  return {
    helperPath,
    helperSettingChanged,
    helperArtifactChanged,
    effectiveConflict,
    targetCompatible,
  };
}

function assistantResponseOptOutIsPrismOwned(env, expectedOtelEnv) {
  return LEGACY_PROJECTION_OWNERSHIP_KEYS.every((key) => (
    Object.prototype.hasOwnProperty.call(expectedOtelEnv, key)
      && env[key] === expectedOtelEnv[key]
  ));
}

function removeLegacyAssistantResponseOptOut(settings, expectedOtelEnv) {
  const env = settings && settings.env;
  if (!env || env[LEGACY_ASSISTANT_RESPONSES_KEY] !== LEGACY_ASSISTANT_RESPONSES_VALUE) {
    return false;
  }
  if (!assistantResponseOptOutIsPrismOwned(env, expectedOtelEnv)) return false;

  delete env[LEGACY_ASSISTANT_RESPONSES_KEY];
  return true;
}

// A recognized "0" opt-out — same scope, or a lower-precedence scope — is excluded from this pass's write so it is never silently overridden.
function projectOtelEnv(expectedOtelEnv, targetEnv, effectiveBefore, targetScope) {
  const env = targetEnv || {};
  const sameScopeOptOut = env[LEGACY_ASSISTANT_RESPONSES_KEY] === LEGACY_ASSISTANT_RESPONSES_VALUE;

  const effectiveEnv = (effectiveBefore && effectiveBefore.env) || {};
  const effectiveSources = (effectiveBefore && effectiveBefore.sources) || {};
  const effectiveSource = effectiveSources[LEGACY_ASSISTANT_RESPONSES_KEY];
  const sourceRank = scopeRank(effectiveSource);
  const targetRank = scopeRank(targetScope);
  const foreignLowerScopeOptOut = effectiveEnv[LEGACY_ASSISTANT_RESPONSES_KEY] === LEGACY_ASSISTANT_RESPONSES_VALUE
    && effectiveSource !== targetScope
    && sourceRank !== null
    && targetRank !== null
    && sourceRank < targetRank;

  if (!sameScopeOptOut && !foreignLowerScopeOptOut) return expectedOtelEnv;
  return Object.fromEntries(
    Object.entries(expectedOtelEnv).filter(([key]) => key !== LEGACY_ASSISTANT_RESPONSES_KEY),
  );
}

function buildExpectedOtelEnv() {
  const config = getConfig();
  const apiKey = config.apiKey;
  const ingestUrl = config.ingest_url;
  if (!hasApiKey(apiKey) || !isSupportedIngestUrl(ingestUrl)) return null;
  // A sealed key belongs to exactly one destination. Refuse to project a pair
  // that no longer matches its seal, so no caller can write the old key against
  // a new ingest URL and then report a successful projection.
  if (verifyBinding(config).status === 'mismatch') return null;

  const baseUrl = ingestUrl.replace(/\/+$/, '');
  return {
    apiKey,
    otelEnv: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${baseUrl}/v1/logs`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${baseUrl}/v1/metrics`,
      OTEL_EXPORTER_OTLP_HEADERS: buildOtelHeaders(apiKey),
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_ASSISTANT_RESPONSES: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
      // Not a hard size guarantee — the ingest service's own body-size check remains the final gate.
      OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: '100',
      OTEL_BLRP_SCHEDULE_DELAY: '1000',
    },
  };
}

function registryEntryMatchesPluginRoot(entry, pluginRoot) {
  if (!pluginRoot) return true;
  if (!entry || typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) {
    return false;
  }
  try {
    return fs.realpathSync(entry.installPath) === fs.realpathSync(pluginRoot);
  } catch {
    return false;
  }
}

function detectInstallScope(projectDir, pluginRoot) {
  const dir = path.resolve(resolveProjectDir(projectDir));
  const installed = readJson(INSTALLED_PLUGINS);
  const entries = installed && installed.plugins && installed.plugins[PLUGIN_ID];
  if (!Array.isArray(entries)) return null;

  const eligibleEntries = entries.filter((entry) =>
    registryEntryMatchesPluginRoot(entry, pluginRoot));
  const matchingEntries = eligibleEntries.filter((entry) =>
    typeof entry.projectPath === 'string'
    && (!pluginRoot || path.isAbsolute(entry.projectPath))
    && path.resolve(entry.projectPath) === dir);
  if (matchingEntries.some((entry) => entry.scope === 'local')) return 'local';
  if (matchingEntries.some((entry) => entry.scope === 'project')) return 'project';

  return eligibleEntries.some((entry) => entry.scope === 'user') ? 'user' : null;
}

function syncOtelSettings({ scope, projectDir, dataDir } = {}) {
  const expected = buildExpectedOtelEnv();
  if (!expected) return false;

  const targetScope = scope || detectInstallScope(projectDir);
  if (!targetScope) return false;

  const file = pathForScope(targetScope, projectDir);
  const update = updateSettingsAtomic(file, (settings) => {
    let helperSettingChanged = false;
    if (dataDir) {
      const helper = projectManagedHelper(settings, projectDir, dataDir);
      helperSettingChanged = helper.helperSettingChanged;
    }

    const currentEnv = settings.env || {};
    const assistantResponseOptOutRemoved = removeLegacyAssistantResponseOptOut(
      settings,
      expected.otelEnv,
    );
    const envAfterCleanup = settings.env || currentEnv;
    const effectiveBefore = readEffectiveSettings(projectDir);
    const projectedOtelEnv = projectOtelEnv(expected.otelEnv, envAfterCleanup, effectiveBefore, targetScope);
    const envChanged = Object.entries(projectedOtelEnv)
      .some(([key, value]) => envAfterCleanup[key] !== value);
    settings.env = { ...envAfterCleanup, ...projectedOtelEnv };
    return {
      settings,
      changed: envChanged || helperSettingChanged || assistantResponseOptOutRemoved,
      assistantResponseOptOutRemoved,
    };
  });
  return update.ok;
}

function syncPluginVersionMetadata({
  scope,
  projectDir,
  dataDir,
  pluginRoot,
  pluginVersion = readPluginVersion(),
} = {}) {
  const expected = buildExpectedOtelEnv();
  if (!expected || !pluginVersion) {
    return { ok: false, changed: false, reason: 'no valid config or plugin version' };
  }

  const targetScope = scope || detectInstallScope(projectDir, pluginRoot);
  if (!targetScope) {
    return { ok: false, changed: false, reason: 'unknown install scope' };
  }

  const helperPath = helperPathForDataDir(dataDir);
  const file = pathForScope(targetScope, projectDir);
  const projectedHeaders = buildOtelHeaders(expected.apiKey, pluginVersion);
  const update = updateSettingsAtomic(file, (settings) => {
    const helper = projectManagedHelper(settings, projectDir, dataDir);
    const assistantResponseOptOutRemoved = removeLegacyAssistantResponseOptOut(
      settings,
      expected.otelEnv,
    );
    const currentHeaders = settings.env && settings.env.OTEL_EXPORTER_OTLP_HEADERS;
    const headerChanged = currentHeaders !== projectedHeaders;
    settings.env = {
      ...(settings.env || {}),
      OTEL_EXPORTER_OTLP_HEADERS: projectedHeaders,
    };
    return {
      settings,
      changed: headerChanged || helper.helperSettingChanged || assistantResponseOptOutRemoved,
      headerChanged,
      assistantResponseOptOutRemoved,
      helperArtifactChanged: helper.helperArtifactChanged,
    };
  });

  if (!update.ok) {
    return {
      ok: false,
      changed: false,
      reason: update.reason,
      scope: targetScope,
      settingsFile: file,
      helperPath,
      helperConfigured: false,
      helperConflict: false,
    };
  }

  const effectiveSettings = readEffectiveSettings(projectDir);
  const effectiveHeaders = effectiveSettings.env.OTEL_EXPORTER_OTLP_HEADERS;
  const effectiveHeaderSource = effectiveSettings.sources.OTEL_EXPORTER_OTLP_HEADERS || null;
  const effectiveHelper = readEffectiveSetting(OTEL_HEADERS_HELPER_KEY, projectDir);
  const helperConfigured = effectiveHelper.value === helperPath;
  const helperConflict = effectiveHelper.value !== undefined && !helperConfigured;
  const headerConfigured = effectiveHeaders === projectedHeaders;

  return {
    ok: headerConfigured,
    changed: update.changed || update.helperArtifactChanged,
    assistantResponseOptOutRemoved: update.assistantResponseOptOutRemoved === true,
    reason: headerConfigured ? undefined : 'effective OTEL headers overridden',
    scope: targetScope,
    settingsFile: file,
    helperPath,
    projectedHeaders,
    effectiveHeaders,
    effectiveHeaderSource,
    helperConfigured,
    helperConflict,
    effectiveHelper: {
      value: effectiveHelper.value,
      source: effectiveHelper.source,
      configured: helperConfigured,
    },
  };
}

function checkOtelSettings({ projectDir, dataDir } = {}) {
  const { env, sources } = readEffectiveSettings(projectDir);
  const expected = buildExpectedOtelEnv();
  if (!expected) return { ok: false, mismatches: ['no valid config'], assistantResponseConflict: null };

  const installScope = detectInstallScope(projectDir);

  const mismatches = [];
  let assistantResponseConflict = null;
  for (const [key, value] of Object.entries(expected.otelEnv)) {
    if (env[key] === value) continue;
    if (key === LEGACY_ASSISTANT_RESPONSES_KEY && env[key] === LEGACY_ASSISTANT_RESPONSES_VALUE) {
      if (!assistantResponseOptOutIsPrismOwned(env, expected.otelEnv)) continue;

      const source = sources[key];
      const sourceRank = scopeRank(source);
      const targetRank = scopeRank(installScope);
      if (source && source !== installScope && sourceRank !== null && targetRank !== null) {
        if (sourceRank < targetRank) {
          continue;
        }
        assistantResponseConflict = { key, source, installScope };
        continue;
      }
    }
    mismatches.push(key);
  }
  if (dataDir) {
    const effectiveHelper = readEffectiveSetting(OTEL_HEADERS_HELPER_KEY, projectDir);
    if (effectiveHelper.value !== helperPathForDataDir(dataDir)) {
      mismatches.push(OTEL_HEADERS_HELPER_KEY);
    }
  }
  return { ok: mismatches.length === 0, mismatches, assistantResponseConflict };
}

/**
 * Explicit config/uninstall cleanup. No setup or runtime path calls this function.
 */
function removeOtelSettings({ scope = 'all', projectDir, dataDir } = {}) {
  let targets;
  if (scope === 'all' || scope === 'both') {
    targets = ['user', 'project', 'local'];
  } else if (scope === 'project-shared') {
    targets = ['project'];
  } else {
    targets = [scope];
  }

  const removed = [];
  for (const targetScope of targets) {
    const file = pathForScope(targetScope, projectDir);
    const settings = readSettings(file);
    let changed = false;
    if (settings.env) {
      for (const key of OTEL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(settings.env, key)) {
          delete settings.env[key];
          changed = true;
        }
      }
      if (Object.keys(settings.env).length === 0) delete settings.env;
    }
    if (dataDir) {
      const helperPath = helperPathForDataDir(dataDir);
      if (settings[OTEL_HEADERS_HELPER_KEY] === helperPath) {
        delete settings[OTEL_HEADERS_HELPER_KEY];
        changed = true;
      }
    }
    if (!changed) continue;

    writeJson(file, settings);
    removed.push(targetScope);
  }
  return removed;
}

/**
 * Remove the current install entry and its enabledPlugins setting during an
 * explicit uninstall. Marketplace registration is preserved.
 */
function cleanupRegistries({ extraProjectDirs } = {}) {
  const cleaned = [];
  const remaining = [];
  const projectDir = process.env.CLAUDE_PROJECT_DIR
    ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
    : null;
  const installed = readJson(INSTALLED_PLUGINS);
  const entries = (installed && installed.plugins && installed.plugins[PLUGIN_ID]) || [];
  if (!Array.isArray(entries) || !installed) return { cleaned, remaining };

  let currentScope = null;
  if (projectDir) {
    const projectEntry = entries.find((entry) => entry.projectPath
      && path.resolve(entry.projectPath) === projectDir);
    if (projectEntry) currentScope = projectEntry.scope || 'local';
  }
  if (!currentScope && entries.some((entry) => entry.scope === 'user')) currentScope = 'user';

  const kept = entries.filter((entry) => {
    if (currentScope === 'user') return entry.scope !== 'user';
    if (!projectDir || !entry.projectPath) return true;
    return path.resolve(entry.projectPath) !== projectDir;
  });

  if (kept.length !== entries.length) {
    if (kept.length === 0) delete installed.plugins[PLUGIN_ID];
    else installed.plugins[PLUGIN_ID] = kept;
    writeJson(INSTALLED_PLUGINS, installed);
    cleaned.push('installed_plugins.json');
  }

  for (const entry of kept) {
    remaining.push(entry.scope === 'user' ? '(user scope)' : entry.projectPath || '(unknown)');
  }

  if (currentScope) {
    const settingsFile = pathForScope(currentScope, projectDir || undefined);
    const settings = readJson(settingsFile);
    if (settings && settings.enabledPlugins && settings.enabledPlugins[PLUGIN_ID]) {
      delete settings.enabledPlugins[PLUGIN_ID];
      if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
      writeJson(settingsFile, settings);
      cleaned.push(settingsFile);
    }
  }

  if (extraProjectDirs) {
    for (const dir of extraProjectDirs) {
      for (const scope of ['project', 'local']) {
        const file = pathForScope(scope, dir);
        const settings = readJson(file);
        if (!settings || !settings.enabledPlugins || !settings.enabledPlugins[PLUGIN_ID]) continue;
        delete settings.enabledPlugins[PLUGIN_ID];
        if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
        writeJson(file, settings);
        cleaned.push(file);
      }
    }
  }

  if (remaining.length === 0) {
    try {
      fs.rmSync(path.join(os.homedir(), '.prism'), { recursive: true, force: true });
      cleaned.push('~/.prism');
    } catch {}
  }

  return { cleaned, remaining };
}

function parseArgs(argv) {
  const args = { scope: null, projectDir: null, dataDir: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--scope') args.scope = argv[++index];
    else if (argv[index] === '--project-dir') args.projectDir = argv[++index];
    else if (argv[index] === '--data-dir') args.dataDir = argv[++index];
  }
  return args;
}

if (require.main === module) {
  const action = process.argv[2] || 'sync';
  const args = parseArgs(process.argv.slice(3));

  if (action === 'install-scope') {
    process.stdout.write(detectInstallScope(args.projectDir) || 'unknown');
    process.exit(0);
  }

  if (action === 'cleanup-registries') {
    const result = cleanupRegistries({ extraProjectDirs: args.projectDir ? [args.projectDir] : [] });
    if (result.cleaned.length === 0) console.log('[prism] No registry entries to clean');
    else console.log(`[prism] Cleaned: ${result.cleaned.join(', ')}`);
    if (result.remaining.length > 0) {
      console.error(`[prism] Plugin still installed in: ${result.remaining.join(', ')}`);
    }
    process.exit(0);
  }

  if (action === 'remove') {
    const removed = removeOtelSettings({
      scope: args.scope || 'all',
      projectDir: args.projectDir,
      dataDir: args.dataDir,
    });
    if (removed.length === 0) console.log('[prism] No OTEL env vars to remove');
    else console.log(`[prism] OTEL env vars removed from: ${removed.join(', ')}`);
    process.exit(0);
  }

  if (action === 'check') {
    const result = checkOtelSettings({ projectDir: args.projectDir, dataDir: args.dataDir });
    console.log(result.ok ? 'ok' : `mismatch:${result.mismatches.join(',')}`);
    process.exit(result.ok ? 0 : 1);
  }

  const scope = args.scope || detectInstallScope(args.projectDir);
  const ok = syncOtelSettings({ scope, projectDir: args.projectDir, dataDir: args.dataDir });
  if (!ok) {
    console.error('[prism] No valid config or install scope');
    process.exit(1);
  }

  console.log(`[prism] OTEL env vars synced to ${pathForScope(scope, args.projectDir)} (scope=${scope})`);
}

module.exports = {
  INSTALLED_PLUGINS,
  OTEL_HEADERS_HELPER_FILENAME,
  OTEL_HEADERS_HELPER_KEY,
  OTEL_KEYS,
  PLUGIN_ID,
  USER_SETTINGS,
  buildExpectedOtelEnv,
  checkOtelSettings,
  cleanupRegistries,
  detectInstallScope,
  helperPathForDataDir,
  inspectManagedOtelHeadersHelper,
  installOtelHeadersHelper,
  localSettingsPath,
  pathForScope,
  projectSettingsPath,
  readEffectiveSetting,
  readEffectiveSettings,
  removeOtelSettings,
  syncOtelSettings,
  syncPluginVersionMetadata,
};
