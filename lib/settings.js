/**
 * Manages OTEL env vars in Claude Code settings files.
 *
 * OTEL env vars must be set BEFORE Claude Code starts (they're read at process init).
 * CLAUDE_ENV_FILE from SessionStart hooks is too late for the telemetry system.
 * We write them to a settings file's "env" section instead.
 *
 * ─── Scope semantics ───────────────────────────────────────────────────────
 *
 * Two valid write targets (exactly one "owns" the OTEL vars at a time):
 *
 *   user    → ~/.claude/settings.json
 *               Active in every project. Default for personal installs.
 *
 *   project → $CLAUDE_PROJECT_DIR/.claude/settings.local.json
 *               Active only in this project. Auto-gitignored by Claude Code,
 *               so it's the safe home for the gck_* key when the plugin is
 *               distributed via a committed project-shared settings.json.
 *
 * We NEVER write to $CLAUDE_PROJECT_DIR/.claude/settings.json (shared, checked
 * in) because the OTEL_EXPORTER_OTLP_HEADERS value embeds the gck_* secret.
 *
 * Ingest URL is read from the config cache (lib/config.js), NOT hardcoded.
 *
 * Called by: install.sh, /prism:setup, /prism:uninstall, session-start.sh
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getConfig } = require('./config');

const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CONFIG_FILE = path.join(os.homedir(), '.prism', 'config.json');
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
  'OTEL_LOG_TOOL_DETAILS',
];

// ─── Path resolution ───

function projectSettingsPath(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(dir, '.claude', 'settings.local.json');
}

function projectSharedSettingsPath(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(dir, '.claude', 'settings.json');
}

function pathForScope(scope, projectDir) {
  if (scope === 'user') return USER_SETTINGS;
  if (scope === 'project') return projectSettingsPath(projectDir);
  throw new Error(`unknown scope: ${scope}`);
}

// ─── Read/write helpers ───

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function hasOtelVars(settings) {
  const env = settings && settings.env;
  if (!env) return false;
  return OTEL_KEYS.some((k) => k in env);
}

// ─── API key + expected env ───

function readApiKey() {
  if (process.env.CLAUDE_PLUGIN_OPTION_apiKey) {
    return process.env.CLAUDE_PLUGIN_OPTION_apiKey;
  }
  const legacy = readJson(CONFIG_FILE);
  return (legacy && legacy.apiKey) || '';
}

function buildExpectedOtelEnv() {
  const apiKey = readApiKey();
  if (!apiKey.startsWith('gck_')) return null;

  const config = getConfig(apiKey);
  const ingestUrl = config.ingest_url;
  if (!ingestUrl) return null;

  return {
    apiKey,
    otelEnv: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${ingestUrl}/v1/logs`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${ingestUrl}/v1/metrics`,
      OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${apiKey}`,
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
    },
  };
}

// ─── Scope detection ───

/**
 * Detect which scope(s) currently hold OTEL vars.
 * Returns one of: 'user' | 'project' | 'both' | 'none'
 *
 * Also surfaces a warning if the project-shared settings.json contains OTEL
 * vars (it shouldn't — that would mean a gck_* key got committed).
 */
function detectActiveScope(projectDir) {
  const user = hasOtelVars(readJson(USER_SETTINGS));
  const project = hasOtelVars(readJson(projectSettingsPath(projectDir)));
  const shared = hasOtelVars(readJson(projectSharedSettingsPath(projectDir)));

  const warnings = [];
  if (shared) {
    warnings.push(
      `OTEL vars found in ${projectSharedSettingsPath(projectDir)} (shared, likely checked in). ` +
        'This can leak your gck_* key — remove them manually.',
    );
  }

  let scope;
  if (user && project) scope = 'both';
  else if (user) scope = 'user';
  else if (project) scope = 'project';
  else scope = 'none';

  return { scope, warnings };
}

// ─── Install-scope detection ───

function detectInstallScope(projectDir) {
  const dir = projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const installed = readJson(INSTALLED_PLUGINS);
  const entries = installed && installed.plugins && installed.plugins[PLUGIN_ID];
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry.scope === 'user') return 'user';
    }
    for (const entry of entries) {
      if (entry.projectPath && path.resolve(entry.projectPath) === path.resolve(dir)) {
        return entry.scope || null;
      }
    }
  }

  return null;
}

/**
 * Central scope resolver. Determines where OTEL vars should live based on
 * install scope (from installed_plugins.json) and active scope (where OTEL
 * vars currently exist). Returns a decision — callers execute it.
 *
 * Returns { action, targetScope, removeScopes, warnings }
 *   action:       'sync' | 'repair' | 'skip'
 *   targetScope:  'user' | 'project' | null (skip)
 *   removeScopes: string[] — scopes to remove OTEL from before syncing
 *   warnings:     string[]
 */
function resolveOtelScope(projectDir) {
  const { scope: activeScope, warnings } = detectActiveScope(projectDir);
  const installScope = detectInstallScope(projectDir);

  if (installScope === 'user') {
    if (activeScope === 'both' || activeScope === 'project') {
      return { action: 'repair', targetScope: 'user', removeScopes: ['project'], warnings };
    }
    return { action: 'sync', targetScope: 'user', removeScopes: [], warnings };
  }

  if (installScope === 'project' || installScope === 'local') {
    if (activeScope === 'user' || activeScope === 'both') {
      return {
        action: 'repair',
        targetScope: 'project',
        removeScopes: ['user'],
        warnings: [...warnings, 'auto-repairing: moving OTEL from user to project scope'],
      };
    }
    return { action: 'sync', targetScope: 'project', removeScopes: [], warnings };
  }

  // installScope is null (unknown)
  if (activeScope === 'both') {
    return {
      action: 'repair',
      targetScope: 'project',
      removeScopes: ['user'],
      warnings: [...warnings, 'install scope unknown; removing user OTEL (project OTEL available as fallback)'],
    };
  }
  if (activeScope === 'user') {
    return {
      action: 'sync',
      targetScope: 'user',
      removeScopes: [],
      warnings: [...warnings, 'install scope unknown; keeping existing user OTEL — run /prism:setup to set scope explicitly'],
    };
  }
  if (activeScope === 'project') {
    return { action: 'sync', targetScope: 'project', removeScopes: [], warnings };
  }

  // activeScope === 'none' — no OTEL anywhere and scope unknown → refuse
  return {
    action: 'skip',
    targetScope: null,
    removeScopes: [],
    warnings: [...warnings, 'scope detection failed — OTEL not written. Restart Claude Code session to auto-detect.'],
  };
}

// ─── Check / sync / remove ───

/**
 * Check whether a given scope has the currently-expected OTEL vars.
 * scope: 'user' | 'project'
 * Returns { ok, mismatches }.
 */
function checkOtelSettings({ scope, projectDir } = { scope: 'user' }) {
  const expected = buildExpectedOtelEnv();
  if (!expected) return { ok: false, mismatches: ['no valid config'] };

  const file = pathForScope(scope, projectDir);
  const settings = readJson(file) || {};
  const currentEnv = settings.env || {};
  const mismatches = [];

  for (const [key, val] of Object.entries(expected.otelEnv)) {
    if (currentEnv[key] !== val) mismatches.push(key);
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Write OTEL env vars into the given scope's settings file.
 * Refuses 'project-shared' — we never write the gck_* key to a checked-in file.
 */
function syncOtelSettings({ scope, projectDir } = { scope: 'user' }) {
  const expected = buildExpectedOtelEnv();
  if (!expected) return false;

  const file = pathForScope(scope, projectDir);
  const settings = readJson(file) || {};

  settings.env = Object.assign({}, settings.env || {}, expected.otelEnv);
  writeJson(file, settings);
  return true;
}

/**
 * Remove OTEL env vars from the given scope.
 * scope: 'user' | 'project' | 'project-shared' | 'all' (or legacy alias 'both')
 *
 * 'all' (and the legacy 'both') sweeps every settings file Claude Code reads:
 *   • user            ~/.claude/settings.json
 *   • project         <project>/.claude/settings.local.json    (gitignored)
 *   • project-shared  <project>/.claude/settings.json          (committed)
 *
 * Used by uninstall to guarantee no stale OTEL keys (or gck_* secrets in
 * OTEL_EXPORTER_OTLP_HEADERS) remain in any layer, regardless of how the
 * plugin was installed or what manual edits a user made.
 */
function removeOtelSettings({ scope, projectDir } = { scope: 'all' }) {
  const isAll = scope === 'all' || scope === 'both';
  const targets = isAll
    ? [
        { scope: 'user',            file: USER_SETTINGS },
        { scope: 'project',         file: projectSettingsPath(projectDir) },
        { scope: 'project-shared',  file: projectSharedSettingsPath(projectDir) },
      ]
    : scope === 'project-shared'
      ? [{ scope: 'project-shared', file: projectSharedSettingsPath(projectDir) }]
      : [{ scope, file: pathForScope(scope, projectDir) }];

  const removed = [];
  for (const { scope: s, file } of targets) {
    const settings = readJson(file);
    if (!settings || !settings.env) continue;

    let changed = false;
    for (const key of OTEL_KEYS) {
      if (key in settings.env) {
        delete settings.env[key];
        changed = true;
      }
    }
    if (!changed) continue;

    if (Object.keys(settings.env).length === 0) delete settings.env;
    writeJson(file, settings);
    removed.push(s);
  }

  return removed;
}

// ─── CLI ───
//
// node settings.js sync   [--scope user|project] [--project-dir PATH]
// node settings.js check  [--scope user|project] [--project-dir PATH]
//   (prints "ok", "mismatch:<keys>", or "no-config"; exits 0/1)
// node settings.js detect [--project-dir PATH]
//   (prints "user" | "project" | "both" | "none" on stdout, warnings on stderr)
// node settings.js remove [--scope user|project|project-shared|all] [--project-dir PATH]
//   ('all' sweeps user + project-local + project-shared; 'both' is a legacy alias for 'all')

function parseArgs(argv) {
  const args = { scope: null, projectDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') args.scope = argv[++i];
    else if (a === '--project-dir') args.projectDir = argv[++i];
  }
  return args;
}

if (require.main === module) {
  const action = process.argv[2] || 'sync';
  const args = parseArgs(process.argv.slice(3));

  if (action === 'detect') {
    const { scope, warnings } = detectActiveScope(args.projectDir);
    for (const w of warnings) console.error(`[prism] WARNING: ${w}`);
    process.stdout.write(scope);
    process.exit(0);
  }

  if (action === 'install-scope') {
    const result = detectInstallScope(args.projectDir);
    process.stdout.write(result || 'unknown');
    process.exit(0);
  }

  if (action === 'resolve-scope') {
    const result = resolveOtelScope(args.projectDir);
    for (const w of result.warnings) console.error(`[prism] WARNING: ${w}`);
    const removePart = (result.removeScopes || []).join(',');
    process.stdout.write(`${result.action}:${result.targetScope || ''}:${removePart}`);
    process.exit(result.action === 'skip' ? 1 : 0);
  }

  if (action === 'remove') {
    const scope = args.scope || 'all';
    const removed = removeOtelSettings({ scope, projectDir: args.projectDir });
    if (removed.length === 0) {
      console.log('[prism] No OTEL env vars to remove');
    } else {
      console.log(`[prism] OTEL env vars removed from: ${removed.join(', ')}`);
    }
    process.exit(0);
  }

  if (action === 'check') {
    const scope = args.scope || 'user';
    const result = checkOtelSettings({ scope, projectDir: args.projectDir });
    if (result.ok) {
      console.log('ok');
      process.exit(0);
    } else {
      console.log('mismatch:' + result.mismatches.join(','));
      process.exit(1);
    }
  }

  // sync
  const scope = args.scope || 'user';
  const ok = syncOtelSettings({ scope, projectDir: args.projectDir });
  if (ok) {
    const file = pathForScope(scope, args.projectDir);
    console.log(`[prism] OTEL env vars synced to ${file} (scope=${scope})`);
    process.exit(0);
  } else {
    console.error('[prism] No valid config — ensure API key is set and config cache exists');
    process.exit(1);
  }
}

module.exports = {
  readApiKey,
  buildExpectedOtelEnv,
  detectActiveScope,
  detectInstallScope,
  resolveOtelScope,
  syncOtelSettings,
  checkOtelSettings,
  removeOtelSettings,
  pathForScope,
  USER_SETTINGS,
  OTEL_KEYS,
};
