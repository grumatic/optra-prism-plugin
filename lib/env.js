/**
 * Shared environment / config constants.
 * API key priority: PRISM_API_KEY → PRISM_GCK_KEY (legacy) → userConfig
 *   → ~/.prism/config.json → default
 *
 * URLs are resolved from the config endpoint (lib/config.js). Ingest can be
 * overridden by PRISM_INGEST_URL or ~/.prism/config.json.ingest_url.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Read legacy config file as fallback ───

const CONFIG_FILE = path.join(os.homedir(), '.prism', 'config.json');
let legacyConfig = {};
try {
  legacyConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {}

// ─── API key + settings (env var → userConfig → legacy) ───

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || '';
const API_KEY = process.env.PRISM_API_KEY
  || process.env.PRISM_GCK_KEY
  || process.env.CLAUDE_PLUGIN_OPTION_apiKey
  || legacyConfig.apiKey
  || '';
const PRISM_THRESHOLD = parseFloat(
  process.env.PRISM_THRESHOLD
  || process.env.CLAUDE_PLUGIN_OPTION_prismThreshold
  || String(legacyConfig.prismThreshold || 4.0)
);
const SHOW_STATUS_LINE = (
  process.env.CLAUDE_PLUGIN_OPTION_showStatusLine
  || legacyConfig.showStatusLine
  || 'true'
) === 'true';

// ─── URL resolution (env override → local config → cache → production) ───

const { getConfig } = require('./config');
const _resolvedConfig = getConfig(API_KEY);
const INGEST_URL = _resolvedConfig.ingest_url;
const OTEL_ENDPOINT = INGEST_URL ? `${INGEST_URL}/v1/logs` : '';

// ─── Debug / state ───

const DEBUG_ENABLED = process.env.PRISM_DEBUG === '1';
const LOG_DIR = DATA_DIR || path.join(os.homedir(), '.prism', 'logs');
const DEBUG_LOG = path.join(LOG_DIR, 'debug.log');
const STATE_FILE = DATA_DIR
  ? path.join(DATA_DIR, 'session-state.json')
  : path.join(os.homedir(), '.prism', 'session-state.json');

module.exports = {
  DATA_DIR,
  API_KEY,
  SHOW_STATUS_LINE,
  INGEST_URL,
  OTEL_ENDPOINT,
  PRISM_THRESHOLD,
  DEBUG_ENABLED,
  DEBUG_LOG,
  STATE_FILE,
};
