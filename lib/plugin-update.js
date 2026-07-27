const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { readPluginVersion } = require('./plugin-version');

const MARKETPLACE_URL = 'https://raw.githubusercontent.com/grumatic/optra-prism-plugin/main/.claude-plugin/marketplace.json';
const UPDATE_CACHE_FILENAME = 'update-check.json';
const ACTIVE_VERSION_FILENAME = 'last-version.txt';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 1000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_CACHE_BYTES = 16 * 1024;
const MAX_ACTIVE_VERSION_BYTES = 128;
const MAX_ETAG_BYTES = 1024;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseStableSemVer(value) {
  if (typeof value !== 'string') return null;
  const match = STABLE_SEMVER.exec(value);
  if (!match) return null;
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function isStableSemVer(value) {
  return parseStableSemVer(value) !== null;
}

function compareStableSemVer(left, right) {
  const leftParts = parseStableSemVer(left);
  const rightParts = parseStableSemVer(right);
  if (!leftParts || !rightParts) return null;

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function readCurrentPluginVersion({ pluginRoot, manifestPath } = {}) {
  const selectedManifest = manifestPath
    || (typeof pluginRoot === 'string' && pluginRoot
      ? path.join(pluginRoot, '.claude-plugin', 'plugin.json')
      : undefined);
  const version = selectedManifest
    ? readPluginVersion(selectedManifest)
    : readPluginVersion();
  return isStableSemVer(version) ? version : null;
}

function emptyCache() {
  return {
    checkedAt: null,
    lastSuccessAt: null,
    etag: null,
    latestVersion: null,
  };
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function normalizeEtag(value) {
  if (typeof value !== 'string') return null;
  if (Buffer.byteLength(value) > MAX_ETAG_BYTES) return null;
  return /^[\x21-\x7e]+$/.test(value) ? value : null;
}

function normalizeCache(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCache();
  return {
    checkedAt: normalizeTimestamp(value.checkedAt),
    lastSuccessAt: normalizeTimestamp(value.lastSuccessAt),
    etag: normalizeEtag(value.etag),
    latestVersion: isStableSemVer(value.latestVersion) ? value.latestVersion : null,
  };
}

function cachePathFor(dataDir) {
  return path.join(dataDir, UPDATE_CACHE_FILENAME);
}

function activeVersionPathFor(dataDir) {
  return path.join(dataDir, ACTIVE_VERSION_FILENAME);
}

function isUsableDataDir(dataDir) {
  return typeof dataDir === 'string'
    && dataDir.length > 0
    && !dataDir.includes('\0')
    && path.isAbsolute(dataDir);
}

function readSmallRegularFile(file, maxBytes) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readUpdateCache(dataDir) {
  if (!isUsableDataDir(dataDir)) return emptyCache();
  const serialized = readSmallRegularFile(cachePathFor(dataDir), MAX_CACHE_BYTES);
  if (serialized === null) return emptyCache();
  try {
    return normalizeCache(JSON.parse(serialized));
  } catch {
    return emptyCache();
  }
}

function atomicWrite(file, contents) {
  const directory = path.dirname(file);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function writeUpdateCache(dataDir, value) {
  if (!isUsableDataDir(dataDir)) return false;
  const cache = normalizeCache(value);
  if (!cache.checkedAt) return false;
  return atomicWrite(cachePathFor(dataDir), `${JSON.stringify(cache, null, 2)}\n`);
}

function readActiveVersion(dataDir) {
  if (!isUsableDataDir(dataDir)) return null;
  const version = readSmallRegularFile(
    activeVersionPathFor(dataDir),
    MAX_ACTIVE_VERSION_BYTES,
  );
  return isStableSemVer(version) ? version : null;
}

function writeActiveVersion(dataDir, version) {
  if (!isUsableDataDir(dataDir) || !isStableSemVer(version)) return false;
  return atomicWrite(activeVersionPathFor(dataDir), version);
}

function defaultRequest(
  requestUrl,
  {
    headers = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(requestUrl);
    } catch {
      reject(new Error('invalid-url'));
      return;
    }
    if (url.protocol !== 'https:') {
      reject(new Error('https-required'));
      return;
    }

    let request;
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const deadline = setTimeout(() => {
      if (request) request.destroy();
      settle(reject, new Error('request-timeout'));
    }, timeoutMs);

    try {
      request = https.request(url, {
        method: 'GET',
        headers,
        timeout: timeoutMs,
      }, (response) => {
        const chunks = [];
        let responseBytes = 0;
        response.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.length;
          if (responseBytes > maxBytes) {
            request.destroy();
            settle(reject, new Error('response-too-large'));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          settle(resolve, {
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks, responseBytes),
          });
        });
        response.on('error', (error) => settle(reject, error));
      });
      request.on('timeout', () => {
        request.destroy();
        settle(reject, new Error('request-timeout'));
      });
      request.on('error', (error) => settle(reject, error));
      request.end();
    } catch (error) {
      settle(reject, error);
    }
  });
}

function resolveNow(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    if (value instanceof Date) {
      const milliseconds = value.getTime();
      if (Number.isFinite(milliseconds)) return milliseconds;
    } else if (typeof value === 'string') {
      const milliseconds = Date.parse(value);
      if (Number.isFinite(milliseconds)) return milliseconds;
    } else if (Number.isFinite(value)) {
      return value;
    }
  } catch {}
  return Date.now();
}

function isCacheFresh(cache, nowMilliseconds, interval) {
  const checkedMilliseconds = cache.checkedAt === null
    ? NaN
    : Date.parse(cache.checkedAt);
  const age = nowMilliseconds - checkedMilliseconds;
  return Number.isFinite(age) && age >= 0 && age < interval;
}

function responseStatus(response) {
  if (!response || typeof response !== 'object') return null;
  const status = response.statusCode === undefined ? response.status : response.statusCode;
  return Number.isInteger(status) ? status : null;
}

function responseBody(response) {
  if (!response || typeof response !== 'object') return null;
  const body = response.body;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

function responseEtag(response) {
  if (!response || typeof response !== 'object' || !response.headers) return null;
  const { headers } = response;
  let value = null;
  if (typeof headers.get === 'function') {
    value = headers.get('etag');
  } else if (typeof headers === 'object') {
    value = headers.etag === undefined ? headers.ETag : headers.etag;
  }
  if (Array.isArray(value)) value = value.length === 1 ? value[0] : null;
  return normalizeEtag(value);
}

function marketplaceVersion(body) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Array.isArray(parsed.plugins)) return null;
    const plugins = parsed.plugins.filter((candidate) => (
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && candidate.name === 'prism'
    ));
    if (plugins.length !== 1) return null;
    return isStableSemVer(plugins[0].version) ? plugins[0].version : null;
  } catch {
    return null;
  }
}

function resultFor({
  currentVersion,
  cache,
  checked,
  cacheFresh,
  status,
}) {
  return {
    currentVersion,
    latestVersion: cache.latestVersion,
    updateAvailable: compareStableSemVer(cache.latestVersion, currentVersion) === 1,
    checked,
    cacheFresh,
    status,
    cache,
  };
}

function attemptedFailure({
  currentVersion,
  dataDir,
  previousCache,
  checkedAt,
  status,
}) {
  const cache = {
    ...previousCache,
    checkedAt,
  };
  const persisted = writeUpdateCache(dataDir, cache);
  return resultFor({
    currentVersion,
    cache,
    checked: true,
    cacheFresh: false,
    status: persisted ? status : 'cache-write-failed',
  });
}

async function checkForPluginUpdate({
  pluginRoot,
  manifestPath,
  dataDir,
  requestFn = defaultRequest,
  now = Date.now,
  interval = CHECK_INTERVAL_MS,
} = {}) {
  const currentVersion = readCurrentPluginVersion({ pluginRoot, manifestPath });
  if (!isUsableDataDir(dataDir)) {
    return resultFor({
      currentVersion,
      cache: emptyCache(),
      checked: false,
      cacheFresh: false,
      status: 'invalid-data-dir',
    });
  }

  const nowMilliseconds = resolveNow(now);
  const checkedAt = new Date(nowMilliseconds).toISOString();
  const selectedInterval = Number.isFinite(interval) && interval >= 0
    ? interval
    : CHECK_INTERVAL_MS;
  const previousCache = readUpdateCache(dataDir);

  if (isCacheFresh(previousCache, nowMilliseconds, selectedInterval)) {
    return resultFor({
      currentVersion,
      cache: previousCache,
      checked: false,
      cacheFresh: true,
      status: 'cache-fresh',
    });
  }

  const headers = { Accept: 'application/json' };
  if (previousCache.etag && previousCache.latestVersion) {
    headers['If-None-Match'] = previousCache.etag;
  }

  let response;
  try {
    response = await requestFn(MARKETPLACE_URL, {
      method: 'GET',
      headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
  } catch {
    return attemptedFailure({
      currentVersion,
      dataDir,
      previousCache,
      checkedAt,
      status: 'request-failed',
    });
  }

  const statusCode = responseStatus(response);
  const body = responseBody(response);
  if (body && body.length > MAX_RESPONSE_BYTES) {
    return attemptedFailure({
      currentVersion,
      dataDir,
      previousCache,
      checkedAt,
      status: 'response-too-large',
    });
  }

  if (statusCode === 304) {
    if (!previousCache.latestVersion) {
      return attemptedFailure({
        currentVersion,
        dataDir,
        previousCache,
        checkedAt,
        status: 'invalid-not-modified',
      });
    }
    const cache = {
      checkedAt,
      lastSuccessAt: checkedAt,
      etag: responseEtag(response) || previousCache.etag,
      latestVersion: previousCache.latestVersion,
    };
    const persisted = writeUpdateCache(dataDir, cache);
    return resultFor({
      currentVersion,
      cache,
      checked: true,
      cacheFresh: false,
      status: persisted ? 'not-modified' : 'cache-write-failed',
    });
  }

  if (statusCode !== 200) {
    return attemptedFailure({
      currentVersion,
      dataDir,
      previousCache,
      checkedAt,
      status: 'unexpected-status',
    });
  }

  if (!body) {
    return attemptedFailure({
      currentVersion,
      dataDir,
      previousCache,
      checkedAt,
      status: 'invalid-response',
    });
  }
  const latestVersion = marketplaceVersion(body);
  if (!latestVersion) {
    return attemptedFailure({
      currentVersion,
      dataDir,
      previousCache,
      checkedAt,
      status: 'invalid-marketplace',
    });
  }

  const cache = {
    checkedAt,
    lastSuccessAt: checkedAt,
    etag: responseEtag(response),
    latestVersion,
  };
  const persisted = writeUpdateCache(dataDir, cache);
  return resultFor({
    currentVersion,
    cache,
    checked: true,
    cacheFresh: false,
    status: persisted ? 'updated-cache' : 'cache-write-failed',
  });
}

module.exports = {
  ACTIVE_VERSION_FILENAME,
  CHECK_INTERVAL_MS,
  MARKETPLACE_URL,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  UPDATE_CACHE_FILENAME,
  activeVersionPathFor,
  cachePathFor,
  checkForPluginUpdate,
  compareStableSemVer,
  defaultRequest,
  isStableSemVer,
  marketplaceVersion,
  parseStableSemVer,
  readActiveVersion,
  readCurrentPluginVersion,
  readUpdateCache,
  writeActiveVersion,
  writeUpdateCache,
};
