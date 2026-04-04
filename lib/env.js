/**
 * Shared environment / config constants.
 * Priority: env var → CLAUDE_PLUGIN_OPTION_* (userConfig) → config cache → ~/.prism/config.json → default
 *
 * URLs are resolved from the config endpoint cache (lib/config.js), NOT hardcoded.
 * For local dev, override with: PRISM_INGEST_URL, PRISM_GATEWAY_URL
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

// ─── URL resolution (env var → config cache → null) ───

const INGEST_URL = process.env.PRISM_INGEST_URL || '';
const GATEWAY_URL = ENABLE_GATEWAY
  ? (process.env.ANTHROPIC_BASE_URL || process.env.PRISM_GATEWAY_URL || '')
  : null;
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  || (INGEST_URL ? `${INGEST_URL}/v1/logs` : '');

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
