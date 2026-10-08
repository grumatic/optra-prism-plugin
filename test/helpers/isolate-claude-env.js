'use strict';

// Strips the host variables that relocate Claude Code's user configuration, so
// no test (or subprocess spawned with process.env) can resolve the developer's
// real config root or plugin cache. A test that needs one of them sets it
// explicitly after this module has run.
//
// Every test file requires this module before anything else; the guard in
// claude-env-isolation.test.js keeps that true.

const ISOLATED_VARIABLES = Object.freeze([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
]);

function isolateClaudeEnv(env = process.env) {
  for (const key of ISOLATED_VARIABLES) delete env[key];
  return env;
}

isolateClaudeEnv();

module.exports = { ISOLATED_VARIABLES, isolateClaudeEnv };
