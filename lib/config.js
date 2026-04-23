/**
 * Config endpoint client — resolves service URLs from the gck_* API key.
 *
 * The plugin ships with ONE bootstrap URL (the production ingest endpoint).
 * The server determines the correct environment from the key's workspace config
 * and returns all service URLs.
 *
 * Priority: cached config → config endpoint → production fallback
 *
 * Cache: ${CLAUDE_PLUGIN_DATA}/config-cache.json (24h TTL, refreshed on key change)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_ENDPOINT = 'https://ingest.prism.optra-ai.com/v1/plugin/config';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Production fallback URLs when config endpoint / cache is unavailable
const PROD_INGEST_URL = 'https://ingest.prism.optra-ai.com';
const PROD_GATEWAY_URL = 'https://gateway.prism.optra-ai.com';
const PROD_DASHBOARD_URL = 'https://dashboard.prism.optra-ai.com';

/**
 * Get the cache file path.
 */
function getCacheFile() {
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
 * Fetch config from the endpoint, compare with cache, and update if changed.
 * Returns { config, changed[] } where changed lists keys that differ from cache.
 * Returns null on failure.
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

    // Compare with existing cache to detect URL changes
    const urlKeys = ['ingest_url', 'gateway_url', 'anthropic_base_url', 'dashboard_url', 'environment'];
    const oldCache = getCachedConfig(apiKey);
    const changed = [];
    if (oldCache) {
      for (const k of urlKeys) {
        if (oldCache[k] && config[k] && oldCache[k] !== config[k]) {
          changed.push({ key: k, from: oldCache[k], to: config[k] });
        }
      }
    }

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

    cacheData._changed = changed;
    return cacheData;
  } catch {
    return null;
  }
}

/**
 * Get resolved config: cache → production fallbacks.
 * Synchronous — only reads cache. Use fetchConfig() for async refresh.
 *
 * Synchronous — reads cache only. The config endpoint is the single source of
 * truth for URLs; no env var overrides are applied.
 */
function getConfig(apiKey) {
  // Try cache
  const cached = getCachedConfig(apiKey);

  // Merge: cache → production fallbacks
  const gatewayUrl = (cached && cached.gateway_url) || PROD_GATEWAY_URL;
  return {
    ingest_url: (cached && cached.ingest_url) || PROD_INGEST_URL,
    gateway_url: gatewayUrl,
    anthropic_base_url: (cached && cached.anthropic_base_url) || gatewayUrl,
    dashboard_url: (cached && cached.dashboard_url) || PROD_DASHBOARD_URL,
    environment: (cached && cached.environment) || 'production',
  };
}

/**
 * Ensure ~/.prism/config-cache.json exists. Tries the config endpoint first;
 * on failure, writes a cache populated with production fallback URLs tagged
 * with `source: "fallback"` so status/debugging can tell them apart from
 * server-confirmed values. Returns the cache object (never null).
 */
async function ensureCache(apiKey) {
  const fetched = await fetchConfig(apiKey);
  if (fetched) return { ...fetched, source: 'server' };

  const fallback = {
    ingest_url: PROD_INGEST_URL,
    gateway_url: PROD_GATEWAY_URL,
    anthropic_base_url: PROD_GATEWAY_URL,
    dashboard_url: PROD_DASHBOARD_URL,
    environment: 'production',
    source: 'fallback',
    key_prefix: apiKey ? apiKey.substring(0, 12) : null,
    cached_at: new Date().toISOString(),
  };

  try {
    const cacheFile = getCacheFile();
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(fallback, null, 2) + '\n');
  } catch {}

  return fallback;
}

module.exports = { fetchConfig, ensureCache, getCachedConfig, getConfig, getCacheFile, CONFIG_ENDPOINT };
