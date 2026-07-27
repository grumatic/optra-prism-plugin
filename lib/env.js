/**
 * Shared runtime configuration constants.
 *
 * ~/.prism/config.json is the only Prism runtime configuration authority.
 * CLAUDE_PLUGIN_DATA remains host-provided storage context.
 */

const path = require('path');
const os = require('os');
const { getConfig, isSupportedIngestUrl } = require('./config');
const { verifyBinding } = require('./binding');

const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || '';
const config = getConfig();

const BINDING = verifyBinding(config);
const BINDING_STATUS = BINDING.status;
const BINDING_BOUND_HOST = BINDING.boundHost;
const BINDING_CURRENT_HOST = BINDING.currentHost;

// A sealed key belongs to exactly one ingest destination. When the stored pair
// no longer matches that seal, withhold the key so every request path takes its
// existing "not configured" skip instead of authenticating against a host the
// key was never verified for.
const STORED_API_KEY = typeof config.apiKey === 'string' ? config.apiKey : '';
const API_KEY = BINDING_STATUS === 'mismatch' ? '' : STORED_API_KEY;

const SHOW_REALTIME_SUMMARY = config.show_realtime_summary === true;
const INGEST_URL = isSupportedIngestUrl(config.ingest_url) ? config.ingest_url : '';

const DEBUG_ENABLED = config.debug === true;
const LOG_DIR = DATA_DIR || path.join(os.homedir(), '.prism', 'logs');
const DEBUG_LOG = path.join(LOG_DIR, 'debug.log');

module.exports = {
  DATA_DIR,
  API_KEY,
  BINDING_BOUND_HOST,
  BINDING_CURRENT_HOST,
  BINDING_STATUS,
  SHOW_REALTIME_SUMMARY,
  INGEST_URL,
  DEBUG_ENABLED,
  DEBUG_LOG,
};
