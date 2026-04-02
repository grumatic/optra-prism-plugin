/**
 * Shared debug logger.
 * Always writes to ~/.prism/logs/debug.log (or $CLAUDE_PLUGIN_DATA/debug.log).
 * PRISM_DEBUG=1 additionally writes to stderr for real-time visibility.
 */

const fs = require('fs');
const path = require('path');
const { DEBUG_ENABLED, DEBUG_LOG } = require('./env');

// Ensure log directory exists on first load
try { fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true }); } catch {}

function createDebug(tag) {
  return function debug(msg) {
    const line = `[${tag} ${new Date().toISOString()}] ${msg}\n`;
    if (DEBUG_ENABLED) {
      process.stderr.write(line);
    }
    try { fs.appendFileSync(DEBUG_LOG, line); } catch {}
  };
}

module.exports = { createDebug };
