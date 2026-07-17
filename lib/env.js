/**
 * Shared environment / config constants.
 * API key priority: PRISM_API_KEY → PRISM_GCK_KEY (legacy) → official userConfig
 *   → compatibility userConfig → ~/.prism/config.json → default
 *
 * URLs are resolved from the config endpoint (lib/config.js). Ingest can be
 * overridden by PRISM_INGEST_URL or ~/.prism/config.json.ingest_url.
 */

const { resolveShowRealtimeSummary, resolveStringOption } = require('./options');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Read legacy config file as fallback ───

const CONFIG_FILE = path.join(os.homedir(), '.prism', 'config.json');
let legacyConfig = {};
try {
  legacyConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {}

// ─── API key + settings (explicit env → userConfig → legacy) ───
const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || '';
const API_KEY = process.env.PRISM_API_KEY
  || process.env.PRISM_GCK_KEY
  || resolveStringOption({
    officialEnv: 'CLAUDE_PLUGIN_OPTION_APIKEY',
    compatEnv: 'CLAUDE_PLUGIN_OPTION_apiKey',
    legacyKey: 'apiKey',
    defaultValue: '',
    legacyConfig,
  }).value;
const PRISM_THRESHOLD = parseFloat(
  process.env.PRISM_THRESHOLD
  || resolveStringOption({
    officialEnv: 'CLAUDE_PLUGIN_OPTION_PRISMTHRESHOLD',
    compatEnv: 'CLAUDE_PLUGIN_OPTION_prismThreshold',
    legacyKey: 'prismThreshold',
    defaultValue: '4.0',
    legacyConfig,
  }).value
);
const SHOW_REALTIME_SUMMARY = resolveShowRealtimeSummary().value;

// ─── URL resolution (env override → local config → cache → production) ───

const { getConfig } = require('./config');
const _resolvedConfig = getConfig(API_KEY);
const INGEST_URL = _resolvedConfig.ingest_url;
const OTEL_ENDPOINT = INGEST_URL ? `${INGEST_URL}/v1/logs` : '';

// ─── Debug / state ───

const DEBUG_ENABLED = process.env.PRISM_DEBUG === '1';
const LOG_DIR = DATA_DIR || path.join(os.homedir(), '.prism', 'logs');
const DEBUG_LOG = path.join(LOG_DIR, 'debug.log');

module.exports = {
  DATA_DIR,
  API_KEY,
  SHOW_REALTIME_SUMMARY,
  INGEST_URL,
  OTEL_ENDPOINT,
  PRISM_THRESHOLD,
  DEBUG_ENABLED,
  DEBUG_LOG,
};
