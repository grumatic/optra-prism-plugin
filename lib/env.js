/**
 * Shared runtime configuration constants.
 *
 * ~/.prism/config.json is the only Prism runtime configuration authority.
 * CLAUDE_PLUGIN_DATA remains host-provided storage context.
 */

const path = require('path');
const os = require('os');
const { getConfig, isSupportedIngestUrl } = require('./config');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || '';
const config = getConfig();

const API_KEY = typeof config.apiKey === 'string' ? config.apiKey : '';
const SHOW_REALTIME_SUMMARY = config.show_realtime_summary === true;
const INGEST_URL = isSupportedIngestUrl(config.ingest_url) ? config.ingest_url : '';

const DEBUG_ENABLED = config.debug === true;
const LOG_DIR = DATA_DIR || path.join(os.homedir(), '.prism', 'logs');
const DEBUG_LOG = path.join(LOG_DIR, 'debug.log');

module.exports = {
  API_KEY,
  SHOW_REALTIME_SUMMARY,
  INGEST_URL,
  DEBUG_ENABLED,
  DEBUG_LOG,
};
