/**
 * Shared environment / config constants.
 * Priority: env var → CLAUDE_PLUGIN_OPTION_* (userConfig) → ~/.prism/config.json → default
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Read legacy config file as fallback ───

const CONFIG_FILE = path.join(os.homedir(), '.prism', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {}

// ─── URL defaults per environment ───

const ENV_RAW = process.env.PRISM_ENV
  || process.env.CLAUDE_PLUGIN_OPTION_environment
  || config.env
  || 'production';
const ENV = ENV_RAW === 'dev' ? 'development' : ENV_RAW;

const DEFAULTS = {
  local: {
    GATEWAY_URL: 'http://localhost:3003',
    CODER_URL: 'http://localhost:9001',
    INGEST_URL: 'http://localhost:9005',
  },
  development: {
    GATEWAY_URL: 'https://gateway.dev.optra-ai.com/v1',
    CODER_URL: 'https://dashboard.prism.dev.optra-ai.com',
    INGEST_URL: 'https://ingest.dev.optra-ai.com',
  },
  staging: {
    GATEWAY_URL: 'https://gateway.staging.optra-ai.com/v1',
    CODER_URL: 'https://dashboard.prism.staging.optra-ai.com',
    INGEST_URL: 'https://ingest.staging.optra-ai.com',
  },
  production: {
    GATEWAY_URL: 'https://gateway.optra-ai.com/v1',
    CODER_URL: 'https://dashboard.prism.optra-ai.com',
    INGEST_URL: 'https://ingest.optra-ai.com',
  },
};

const urls = DEFAULTS[ENV] || DEFAULTS.production;

// ─── Exports (env var → userConfig → config.json → default) ───

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || '';
const GCK_KEY = process.env.PRISM_GCK_KEY
  || process.env.CLAUDE_PLUGIN_OPTION_apiKey
  || config.apiKey
  || '';
const ENABLE_GATEWAY = (
  process.env.CLAUDE_PLUGIN_OPTION_enableGateway
  || config.enableGateway
  || 'false'
) === 'true';
const CODER_URL = process.env.PRISM_CODER_URL || urls.CODER_URL;
const INGEST_URL = process.env.PRISM_INGEST_URL || urls.INGEST_URL;
const GATEWAY_URL = ENABLE_GATEWAY
  ? (process.env.ANTHROPIC_BASE_URL || urls.GATEWAY_URL)
  : null;
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || `${INGEST_URL}/v1/logs`;
const PRISM_THRESHOLD = parseFloat(
  process.env.PRISM_THRESHOLD
  || process.env.CLAUDE_PLUGIN_OPTION_prismThreshold
  || String(config.prismThreshold || 4.0)
);
const DEBUG_ENABLED = process.env.PRISM_DEBUG === '1';
const LOG_DIR = DATA_DIR || path.join(os.homedir(), '.prism', 'logs');
const DEBUG_LOG = path.join(LOG_DIR, 'debug.log');
const STATE_FILE = DATA_DIR ? path.join(DATA_DIR, 'session-state.json') : '';

module.exports = {
  ENV,
  DATA_DIR,
  GCK_KEY,
  ENABLE_GATEWAY,
  CODER_URL,
  INGEST_URL,
  GATEWAY_URL,
  OTEL_ENDPOINT,
  PRISM_THRESHOLD,
  DEBUG_ENABLED,
  DEBUG_LOG,
  STATE_FILE,
};
