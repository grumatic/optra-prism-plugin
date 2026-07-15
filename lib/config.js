/**
 * Config endpoint client — resolves service URLs from the Prism API key.
 *
 * The plugin ships with ONE bootstrap URL (the production ingest endpoint).
 * The server determines the correct environment from the key's workspace config
 * and returns the ingest, dashboard, and environment settings used by the plugin.
 *
 * Ingest priority: PRISM_INGEST_URL → ~/.prism/config.json.ingest_url
 *   → cached config → production fallback
 *
 * Cache: ${CLAUDE_PLUGIN_DATA}/config-cache.json (24h TTL, refreshed on key change)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fingerprintApiKey, isSupportedApiKey } = require('./api-key');
const { addPluginVersionHeader } = require('./plugin-version');

const CONFIG_ENDPOINT = 'https://ingest.optra-prism.com/v1/plugin/config';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Production fallback URLs when config endpoint / cache is unavailable
const PROD_INGEST_URL = 'https://ingest.optra-prism.com';
const PROD_DASHBOARD_URL = 'https://dashboard.optra-prism.com';

const REMOTE_CONFIG_KEYS = ['ingest_url', 'dashboard_url', 'environment'];
const CACHE_METADATA_KEYS = ['api_key_fingerprint', 'cached_at', 'source'];

function pickKeys(config, keys) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};

  const picked = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(config, key)) picked[key] = config[key];
  }
  return picked;
}

function pickRemoteConfig(config) {
  return pickKeys(config, REMOTE_CONFIG_KEYS);
}

function getLocalConfigFile() {
  return path.join(os.homedir(), '.prism', 'config.json');
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/\/+$/, '');
}

function validateIngestOverride(value) {
  if (typeof value !== 'string' || !value.trim()) return null;

  const raw = value.trim();
  if (raw.includes('?') || raw.includes('#')) return null;

  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    if (url.protocol === 'http:') {
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      const isLoopback = hostname === 'localhost'
        || hostname === '::1'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname);
      if (!isLoopback) return null;
    }

    return normalizeBaseUrl(url.toString());
  } catch {
    return null;
  }
}

/**
 * Return the explicit local ingest override state:
 *   undefined = absent, null = present but invalid, string = valid.
 */
function getIngestOverride() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'PRISM_INGEST_URL')) {
    return validateIngestOverride(process.env.PRISM_INGEST_URL);
  }

  try {
    const raw = fs.readFileSync(getLocalConfigFile(), 'utf8');
    const config = JSON.parse(raw);
    if (Object.prototype.hasOwnProperty.call(config, 'ingest_url')) {
      return validateIngestOverride(config.ingest_url);
    }
  } catch {}

  return undefined;
}

/**
 * Resolve the effective ingest base without changing any other service URL.
 */
function resolveIngestUrl(config) {
  const override = getIngestOverride();
  if (override !== undefined) return override;
  return normalizeBaseUrl(config && config.ingest_url) || PROD_INGEST_URL;
}

/**
 * Local ingest overrides also select the matching config endpoint. With no
 * override, retain the production bootstrap endpoint used by existing clients.
 */
function getConfigEndpoint() {
  const override = getIngestOverride();
  if (override === null) return null;
  return override === undefined ? CONFIG_ENDPOINT : `${override}/v1/plugin/config`;
}

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

    // Validate cache has required fields. Legacy routing fields may remain on
    // disk after an upgrade, but are deliberately excluded from the result.
    if (!cache.ingest_url || !cache.cached_at) return null;

    // Bind the cache to the full API key without persisting the credential.
    // Prefix-based legacy caches are intentionally refreshed once.
    const fingerprint = fingerprintApiKey(apiKey);
    if (!fingerprint || cache.api_key_fingerprint !== fingerprint) return null;

    // Check TTL
    const age = Date.now() - new Date(cache.cached_at).getTime();
    if (age > CACHE_TTL_MS) return null;

    return {
      ...pickRemoteConfig(cache),
      ...pickKeys(cache, CACHE_METADATA_KEYS),
    };
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
  if (!isSupportedApiKey(apiKey)) return null;

  try {
    const endpoint = getConfigEndpoint();
    if (!endpoint) return null;

    const res = await fetch(endpoint, {
      headers: addPluginVersionHeader({ 'x-api-key': apiKey }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const config = pickRemoteConfig(await res.json());
    if (!config.ingest_url) return null;

    // Compare with existing cache to detect URL changes
    const urlKeys = REMOTE_CONFIG_KEYS;
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
      api_key_fingerprint: fingerprintApiKey(apiKey),
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
 * Get resolved config: explicit ingest override → cache → production.
 * Synchronous — reads cache and applies the local ingest override, if any.
 * Use fetchConfig() for refresh.
 */
function getConfig(apiKey) {
  // Try cache
  const cached = getCachedConfig(apiKey);

  return {
    ingest_url: resolveIngestUrl(cached),
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
  if (fetched) {
    return { ...fetched, ingest_url: resolveIngestUrl(fetched), source: 'server' };
  }

  const fallback = {
    ingest_url: PROD_INGEST_URL,
    dashboard_url: PROD_DASHBOARD_URL,
    environment: 'production',
    source: 'fallback',
    api_key_fingerprint: fingerprintApiKey(apiKey),
    cached_at: new Date().toISOString(),
  };

  try {
    const cacheFile = getCacheFile();
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(fallback, null, 2) + '\n');
  } catch {}

  return { ...fallback, ingest_url: resolveIngestUrl(fallback) };
}

module.exports = {
  fetchConfig,
  ensureCache,
  getCachedConfig,
  getConfig,
  getCacheFile,
  getConfigEndpoint,
  getIngestOverride,
  resolveIngestUrl,
  CONFIG_ENDPOINT,
};
