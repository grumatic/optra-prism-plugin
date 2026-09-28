'use strict';

// Pins the Claude Code version that lib/host-telemetry.js resolves, for this
// test file and every subprocess it spawns with process.env.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');

const LEGACY_HOST_VERSION = '2.1.281';
const CURRENT_HOST_VERSION = '2.1.282';

function writeFakeClaudeHost(dir, version) {
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  return file;
}

function pinClaudeHostVersion(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-claude-host-'));
  const present = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CODE_EXECPATH');
  const previous = process.env.CLAUDE_CODE_EXECPATH;
  process.env.CLAUDE_CODE_EXECPATH = writeFakeClaudeHost(dir, version);
  after(() => {
    if (present) process.env.CLAUDE_CODE_EXECPATH = previous;
    else delete process.env.CLAUDE_CODE_EXECPATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

module.exports = {
  CURRENT_HOST_VERSION,
  LEGACY_HOST_VERSION,
  pinClaudeHostVersion,
  writeFakeClaudeHost,
};
