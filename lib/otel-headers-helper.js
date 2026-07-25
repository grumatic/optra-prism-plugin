#!/usr/bin/env node
'use strict';

/**
 * Stable OTEL headers helper installed into CLAUDE_PLUGIN_DATA/bin.
 *
 * The installed copy must remain self-contained because plugin cache paths
 * change across versions. It reads the durable Prism config and active-version
 * marker on every invocation so hosts that have not restarted can eventually
 * refresh both headers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION_HEADER = 'x-prism-plugin-version';
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJsonObject(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('expected a JSON object');
  }
  return value;
}

function readStableVersion(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return STABLE_SEMVER.test(value) ? value : null;
  } catch {
    return null;
  }
}

function buildHeaders({
  homeDir = os.homedir(),
  dataDir = path.resolve(path.dirname(__filename), '..'),
} = {}) {
  const config = readJsonObject(path.join(homeDir, '.prism', 'config.json'));
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new TypeError('Prism API key is unavailable');
  }

  const headers = { 'x-api-key': config.apiKey };
  const version = readStableVersion(path.join(dataDir, 'last-version.txt'));
  if (version) headers[VERSION_HEADER] = version;
  return headers;
}

function main() {
  try {
    process.stdout.write(`${JSON.stringify(buildHeaders())}\n`);
    return 0;
  } catch {
    process.stderr.write('[Prism] OTEL headers unavailable\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  STABLE_SEMVER,
  VERSION_HEADER,
  buildHeaders,
  main,
  readStableVersion,
};
