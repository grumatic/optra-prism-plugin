/**
 * Config endpoint client — resolves service URLs from the gck_* API key.
 *
 * The plugin ships with ONE bootstrap URL (the production ingest endpoint).
 * The server determines the correct environment from the key's workspace config
 * and returns all service URLs.
 *
 * Priority: env var override → cached config → config endpoint → error
 *
 * Cache: ${CLAUDE_PLUGIN_DATA}/config-cache.json (24h TTL, refreshed on key change)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_ENDPOINT = 'https://ingest.prism.optra-ai.com/v1/plugin/config';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get the cache file path.
 */
function getCacheFile() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (dataDir) return path.join(dataDir, 'config-cache.json');
  return path.join(os.homedir(), '.prism', 'config-cache.json');
}

/**
 * Read cached config. Returns null if missing, expired, or key changed.
 */
function getCachedConfig(apiKey) {
  try {
    const raw = fs.readFileSync(getCacheFile(), 'utf8');
    const cache = JSON.parse(raw);

    // Validate cache has required fields
    if (!cache.ingest_url || !cache.gateway_url || !cache.cached_at) return null;

    // Check if key changed since cache was written
    if (cache.key_prefix && apiKey) {
      const currentPrefix = apiKey.substring(0, 12);
      if (cache.key_prefix !== currentPrefix) return null;
    }

    // Check TTL
    const age = Date.now() - new Date(cache.cached_at).getTime();
    if (age > CACHE_TTL_MS) return null;

    return cache;
  } catch {
    return null;
  }
}

/**
 * Fetch config from the endpoint and write to cache.
 * Returns the config object or null on failure.
 */
async function fetchConfig(apiKey) {
  if (!apiKey || !apiKey.startsWith('gck_')) return null;

  try {
    const res = await fetch(CONFIG_ENDPOINT, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const config = await res.json();
    if (!config.ingest_url) return null;

    // Write cache
    const cacheData = {
      ...config,
      key_prefix: apiKey.substring(0, 12),
      cached_at: new Date().toISOString(),
    };

    try {
      const cacheFile = getCacheFile();
      const dir = path.dirname(cacheFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2) + '\n');
    } catch {}

    return cacheData;
  } catch {
    return null;
  }
}

/**
 * Get resolved config: env var overrides → cache → fetch.
 * Synchronous — only reads cache. Use fetchConfig() for async refresh.
 */
function getConfig(apiKey) {
  // Check env var overrides first
  const envIngest = process.env.PRISM_INGEST_URL || null;
  const envGateway = process.env.PRISM_GATEWAY_URL || null;

  // If both URLs are overridden, skip cache entirely
  if (envIngest && envGateway) {
    return { ingest_url: envIngest, gateway_url: envGateway, anthropic_base_url: envGateway, dashboard_url: null, environment: null };
  }

  // Try cache
  const cached = getCachedConfig(apiKey);

  // Merge: env var overrides take precedence over cache
  const gatewayUrl = envGateway || (cached && cached.gateway_url) || null;
  return {
    ingest_url: envIngest || (cached && cached.ingest_url) || null,
    gateway_url: gatewayUrl,
    anthropic_base_url: (cached && cached.anthropic_base_url) || gatewayUrl,
    dashboard_url: (cached && cached.dashboard_url) || null,
    environment: (cached && cached.environment) || null,
  };
}

module.exports = { fetchConfig, getCachedConfig, getConfig, getCacheFile, CONFIG_ENDPOINT };
