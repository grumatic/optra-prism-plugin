/**
 * Prism runtime configuration.
 *
 * ~/.prism/config.json is the only runtime configuration authority. Remote
 * configuration is fetched on demand and persisted by the caller.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasApiKey } = require('./api-key');
const { addPluginVersionHeader } = require('./plugin-version');

const CONFIG_ENDPOINT = 'https://ingest.optra-prism.com/v1/plugin/config';
const REMOTE_CONFIG_KEYS = ['ingest_url', 'dashboard_url'];

const DEFAULT_CONFIG = {
  apiKey: '',
  showRealtimeSummary: false,
};

function isSupportedIngestUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false;
  if (value.includes('?') || value.includes('#')) return false;

  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost'
      || hostname === '::1'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

function getConfigFile() {
  return path.join(os.homedir(), '.prism', 'config.json');
}

function readConfig() {
  const file = getConfigFile();

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error(`Unable to read Prism config at ${file}: ${error.message}`);
  }
}

function writeConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('Prism config must be a JSON object');
  }

  const file = getConfigFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return config;
}

function patchConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Prism config patch must be a JSON object');
  }

  return writeConfig({ ...readConfig(), ...patch });
}

function getConfig() {
  return { ...DEFAULT_CONFIG, ...readConfig() };
}

function pickRemoteConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const config = {};
  for (const key of REMOTE_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) config[key] = value[key];
  }
  return config;
}

function getConfigEndpoint() {
  const localConfig = readConfig();
  if (!Object.prototype.hasOwnProperty.call(localConfig, 'ingest_url')) {
    return CONFIG_ENDPOINT;
  }

  if (!isSupportedIngestUrl(localConfig.ingest_url)) {
    throw new Error(
      'ingest_url in ~/.prism/config.json must use HTTPS, or HTTP on loopback, ' +
        'without credentials, query, or fragment',
    );
  }
  return `${localConfig.ingest_url.replace(/\/+$/, '')}/v1/plugin/config`;
}

/**
 * Fetch remote service configuration without reading or writing a cache.
 */
async function fetchConfig(apiKey) {
  if (!hasApiKey(apiKey)) return { status: 'missing-key' };

  try {
    const endpoint = getConfigEndpoint();
    const res = await fetch(endpoint, {
      headers: addPluginVersionHeader({ 'x-api-key': apiKey }),
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 401 || res.status === 403) {
      return { status: 'auth-error', authStatus: res.status };
    }
    if (!res.ok) {
      return {
        status: 'error',
        message: `Config endpoint returned HTTP ${res.status}.`,
        httpStatus: res.status,
      };
    }

    let response;
    try {
      response = await res.json();
    } catch (error) {
      return {
        status: 'error',
        message: `Config endpoint returned invalid JSON: ${error.message}`,
        httpStatus: res.status,
      };
    }

    const config = pickRemoteConfig(response);
    if (!isSupportedIngestUrl(config.ingest_url)) {
      return {
        status: 'error',
        message:
          'Config endpoint response is missing a supported ingest_url ' +
          '(HTTPS, or HTTP on loopback, without credentials, query, or fragment).',
        httpStatus: res.status,
      };
    }
    return { status: 'server', config };
  } catch (error) {
    return {
      status: 'error',
      message: `Unable to fetch Prism configuration: ${error.message}`,
    };
  }
}

module.exports = {
  fetchConfig,
  getConfig,
  isSupportedIngestUrl,
  patchConfig,
  readConfig,
  writeConfig,
};
