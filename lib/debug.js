/**
 * Shared debug logger.
 * Always writes to ~/.prism/logs/debug.log (or $CLAUDE_PLUGIN_DATA/debug.log).
 * config.json `debug: true` additionally writes to stderr for real-time visibility.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function createDebug(tag) {
  return function debug(msg) {
    const line = `[${tag} ${new Date().toISOString()}] ${msg}\n`;
    let debugEnabled = false;
    let debugLog = path.join(os.homedir(), '.prism', 'logs', 'debug.log');
    try {
      const env = require('./env');
      debugEnabled = env.DEBUG_ENABLED;
      debugLog = env.DEBUG_LOG;
    } catch {}

    if (debugEnabled) {
      process.stderr.write(line);
    }
    try {
      fs.mkdirSync(path.dirname(debugLog), { recursive: true });
      fs.appendFileSync(debugLog, line);
    } catch {}
  };
}

module.exports = { createDebug };
