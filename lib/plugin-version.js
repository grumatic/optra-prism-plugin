const fs = require('fs');
const path = require('path');

const HEADER_NAME = 'x-prism-plugin-version';
const CANONICAL_MANIFEST = path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json');

function normalizePluginVersion(value) {
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!normalized || normalized.length > 64) return null;
  if (!/^[A-Za-z0-9._+-]+$/.test(normalized)) return null;

  return normalized;
}

function readPluginVersion(manifestFile = CANONICAL_MANIFEST) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    return normalizePluginVersion(manifest.version);
  } catch {
    return null;
  }
}

function addPluginVersionHeader(headers, pluginVersion) {
  const selectedVersion = arguments.length < 2 ? readPluginVersion() : pluginVersion;
  const normalized = normalizePluginVersion(selectedVersion);
  if (normalized) headers[HEADER_NAME] = normalized;
  return headers;
}

function buildOtelHeaders(apiKey, pluginVersion) {
  const selectedVersion = arguments.length < 2 ? readPluginVersion() : pluginVersion;
  const normalized = normalizePluginVersion(selectedVersion);
  // OTLP environment headers use W3C Baggage encoding for values.
  const apiKeyHeader = `x-api-key=${encodeURIComponent(apiKey)}`;
  return normalized ? `${apiKeyHeader},${HEADER_NAME}=${normalized}` : apiKeyHeader;
}

module.exports = {
  HEADER_NAME,
  normalizePluginVersion,
  readPluginVersion,
  addPluginVersionHeader,
  buildOtelHeaders,
};
