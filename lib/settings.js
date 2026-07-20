/**
 * Reads Claude Code settings and writes Prism OTEL settings to the plugin's
 * installed scope.
 *
 * Scope mapping:
 *   user    -> ~/.claude/settings.json
 *   project -> <project>/.claude/settings.json
 *   local   -> <project>/.claude/settings.local.json
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasApiKey } = require('./api-key');
const { getConfig, isSupportedIngestUrl } = require('./config');
const { buildOtelHeaders } = require('./plugin-version');

const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const INSTALLED_PLUGINS = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
const PLUGIN_ID = 'prism@optra-prism';

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
];

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

function buildExpectedOtelEnv() {
  const config = getConfig();
  const apiKey = config.apiKey;
  const ingestUrl = config.ingest_url;
  if (!hasApiKey(apiKey) || !isSupportedIngestUrl(ingestUrl)) return null;

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
      OTEL_LOG_ASSISTANT_RESPONSES: '0',
      OTEL_LOG_TOOL_DETAILS: '1',
    },
  };
}

function detectInstallScope(projectDir) {
  const dir = path.resolve(resolveProjectDir(projectDir));
  const installed = readJson(INSTALLED_PLUGINS);
  const entries = installed && installed.plugins && installed.plugins[PLUGIN_ID];
  if (!Array.isArray(entries)) return null;

  const matchingEntries = entries.filter((entry) => entry.projectPath
    && path.resolve(entry.projectPath) === dir);
  if (matchingEntries.some((entry) => entry.scope === 'local')) return 'local';
  if (matchingEntries.some((entry) => entry.scope === 'project')) return 'project';

  return entries.some((entry) => entry.scope === 'user') ? 'user' : null;
}

function syncOtelSettings({ scope, projectDir } = {}) {
  const expected = buildExpectedOtelEnv();
  if (!expected) return false;

  const targetScope = scope || detectInstallScope(projectDir);
  if (!targetScope) return false;

  const file = pathForScope(targetScope, projectDir);
  const settings = readSettings(file);
  settings.env = { ...(settings.env || {}), ...expected.otelEnv };
  writeJson(file, settings);
  return true;
}

function checkOtelSettings({ projectDir } = {}) {
  const { env } = readEffectiveSettings(projectDir);
  const expected = buildExpectedOtelEnv();
  if (!expected) return { ok: false, mismatches: ['no valid config'] };

  const mismatches = [];
  for (const [key, value] of Object.entries(expected.otelEnv)) {
    if (env[key] !== value) mismatches.push(key);
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Explicit config/uninstall cleanup. No setup or runtime path calls this function.
 */
function removeOtelSettings({ scope = 'all', projectDir } = {}) {
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
    if (!settings.env) continue;

    let changed = false;
    for (const key of OTEL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(settings.env, key)) {
        delete settings.env[key];
        changed = true;
      }
    }
    if (!changed) continue;

    if (Object.keys(settings.env).length === 0) delete settings.env;
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
  const args = { scope: null, projectDir: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--scope') args.scope = argv[++index];
    else if (argv[index] === '--project-dir') args.projectDir = argv[++index];
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
    const removed = removeOtelSettings({ scope: args.scope || 'all', projectDir: args.projectDir });
    if (removed.length === 0) console.log('[prism] No OTEL env vars to remove');
    else console.log(`[prism] OTEL env vars removed from: ${removed.join(', ')}`);
    process.exit(0);
  }

  if (action === 'check') {
    const result = checkOtelSettings({ projectDir: args.projectDir });
    console.log(result.ok ? 'ok' : `mismatch:${result.mismatches.join(',')}`);
    process.exit(result.ok ? 0 : 1);
  }

  const scope = args.scope || detectInstallScope(args.projectDir);
  const ok = syncOtelSettings({ scope, projectDir: args.projectDir });
  if (!ok) {
    console.error('[prism] No valid config or install scope');
    process.exit(1);
  }

  console.log(`[prism] OTEL env vars synced to ${pathForScope(scope, args.projectDir)} (scope=${scope})`);
}

module.exports = {
  INSTALLED_PLUGINS,
  OTEL_KEYS,
  PLUGIN_ID,
  USER_SETTINGS,
  buildExpectedOtelEnv,
  checkOtelSettings,
  cleanupRegistries,
  detectInstallScope,
  localSettingsPath,
  pathForScope,
  projectSettingsPath,
  readEffectiveSettings,
  removeOtelSettings,
  syncOtelSettings,
};
