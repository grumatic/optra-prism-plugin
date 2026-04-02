/**
 * Manages ~/.claude/settings.json OTEL env vars.
 *
 * OTEL env vars must be set BEFORE Claude Code starts (they're read at process init).
 * CLAUDE_ENV_FILE from SessionStart hooks is too late for the telemetry system.
 * So we write them to ~/.claude/settings.json "env" section instead.
 *
 * Reads config from: CLAUDE_PLUGIN_OPTION_* (userConfig) → ~/.prism/config.json (legacy)
 *
 * Called by: install.sh, /prism:setup, session-start.sh (check + sync)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const CONFIG_FILE = path.join(os.homedir(), '.prism', 'config.json');

const URL_DEFAULTS = {
  local: { INGEST_URL: 'http://localhost:9005' },
  development: { INGEST_URL: 'https://ingest.dev.optra-ai.com' },
  staging: { INGEST_URL: 'https://ingest.staging.optra-ai.com' },
  production: { INGEST_URL: 'https://ingest.optra-ai.com' },
};

/**
 * Read config from userConfig env vars, falling back to ~/.prism/config.json.
 */
function readConfig() {
  let legacy = {};
  try {
    legacy = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}

  return {
    apiKey: process.env.CLAUDE_PLUGIN_OPTION_apiKey || legacy.apiKey || '',
    env: process.env.CLAUDE_PLUGIN_OPTION_environment || legacy.env || 'production',
  };
}

/**
 * Build the expected OTEL env vars.
 * Returns { otelEnv, apiKey, env } or null if config is missing/invalid.
 */
function buildExpectedOtelEnv() {
  const config = readConfig();

  const apiKey = config.apiKey;
  if (!apiKey.startsWith('gck_')) return null;

  const envRaw = config.env;
  const env = envRaw === 'dev' ? 'development' : envRaw;
  const urls = URL_DEFAULTS[env] || URL_DEFAULTS.production;
  const ingestUrl = urls.INGEST_URL;

  return {
    apiKey,
    env,
    otelEnv: {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${ingestUrl}/v1/logs`,
      OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${apiKey}`,
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
    },
  };
}

/**
 * Check if ~/.claude/settings.json has the correct OTEL env vars.
 * Returns { ok, mismatches } where mismatches lists keys that differ.
 */
function checkOtelSettings() {
  const expected = buildExpectedOtelEnv();
  if (!expected) return { ok: false, mismatches: ['no valid config'] };

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}

  const currentEnv = settings.env || {};
  const mismatches = [];

  for (const [key, val] of Object.entries(expected.otelEnv)) {
    if (currentEnv[key] !== val) {
      mismatches.push(key);
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Write OTEL env vars to ~/.claude/settings.json.
 * Returns true if settings were updated.
 */
function syncOtelSettings() {
  const expected = buildExpectedOtelEnv();
  if (!expected) return false;

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}

  settings.env = Object.assign({}, settings.env || {}, expected.otelEnv);

  const claudeDir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

/**
 * Remove OTEL env vars from ~/.claude/settings.json.
 */
function removeOtelSettings() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return;
  }

  if (!settings.env) return;

  const otelKeys = [
    'CLAUDE_CODE_ENABLE_TELEMETRY',
    'OTEL_LOGS_EXPORTER',
    'OTEL_EXPORTER_OTLP_PROTOCOL',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_LOG_USER_PROMPTS',
    'OTEL_LOG_TOOL_DETAILS',
  ];

  for (const key of otelKeys) {
    delete settings.env[key];
  }

  if (Object.keys(settings.env).length === 0) {
    delete settings.env;
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

// CLI: node settings.js [sync|check|remove]
if (require.main === module) {
  const action = process.argv[2] || 'sync';
  if (action === 'remove') {
    removeOtelSettings();
    console.log('[prism] OTEL env vars removed from Claude Code settings');
  } else if (action === 'check') {
    const result = checkOtelSettings();
    if (result.ok) {
      console.log('ok');
    } else {
      console.log('mismatch:' + result.mismatches.join(','));
      process.exit(1);
    }
  } else {
    const updated = syncOtelSettings();
    if (updated) {
      console.log('[prism] OTEL env vars synced to ~/.claude/settings.json');
    } else {
      console.error('[prism] No valid API key found — skipping OTEL settings');
      process.exit(1);
    }
  }
}

module.exports = { syncOtelSettings, checkOtelSettings, removeOtelSettings };
