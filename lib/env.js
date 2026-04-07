/**
 * Shared environment / config constants.
 * Priority: CLAUDE_PLUGIN_OPTION_* (userConfig) → config cache → ~/.prism/config.json → default
 *
 * URLs are resolved from the config endpoint (lib/config.js).
 * Only PRISM_INGEST_URL can be overridden via env var (for local dev).
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
const GCK_KEY = process.env.PRISM_GCK_KEY
  || process.env.CLAUDE_PLUGIN_OPTION_apiKey
  || legacyConfig.apiKey
  || '';
const ENABLE_GATEWAY = (
  process.env.CLAUDE_PLUGIN_OPTION_enableGateway
  || legacyConfig.enableGateway
  || 'true'
) === 'true';
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

// ─── URL resolution (PRISM_INGEST_URL override → config cache → production fallback) ───

const { getConfig } = require('./config');
const _resolvedConfig = getConfig(GCK_KEY);
const INGEST_URL = process.env.PRISM_INGEST_URL || _resolvedConfig.ingest_url;
const GATEWAY_URL = ENABLE_GATEWAY ? _resolvedConfig.gateway_url : null;
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
  GCK_KEY,
  ENABLE_GATEWAY,
  SHOW_STATUS_LINE,
  INGEST_URL,
  GATEWAY_URL,
  OTEL_ENDPOINT,
  PRISM_THRESHOLD,
  DEBUG_ENABLED,
  DEBUG_LOG,
  STATE_FILE,
};
