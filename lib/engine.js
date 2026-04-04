/**
 * Engine intelligence API client.
 *
 * Calls the Prism Engine intelligence endpoints via the ingest proxy.
 * The ingest service (public, authenticates gck_*) proxies to the engine (private).
 *
 * For local dev, override with: PRISM_INGEST_URL env var.
 *
 * Returns: { ok, reason, data }
 *   ok=true,  data=<response>        — success
 *   ok=false, reason="no_api_key"    — gck_* key not configured
 *   ok=false, reason="no_ingest_url" — ingest URL not resolved
 *   ok=false, reason="http_error"    — server returned non-200 (status included)
 *   ok=false, reason="network_error" — connection failed (message included)
 *   ok=false, reason="timeout"       — request timed out
 *   ok=false, reason="parse_error"   — response was not valid JSON
 *
 * Used by: commands (session, waste, focus, trends, worst, habits, report)
 */

const https = require('https');
const http = require('http');
const { GCK_KEY, INGEST_URL } = require('./env');
const { createDebug } = require('./debug');

const debug = createDebug('engine');

// ─── Result helpers ───

function ok(data) { return { ok: true, reason: null, data }; }
function fail(reason, detail) { return { ok: false, reason, data: null, detail: detail || null }; }

/**
 * GET /v1/telemetry/logs — fetch OTEL log events (includes cache token data).
 * @param {object} params - { session_id?, from?, to?, limit?, offset? }
 */
async function fetchTelemetryLogs(params = {}) {
  return get('/v1/telemetry/logs', params);
}

/**
 * GET /v1/intelligence/prism — fetch PRISM scores.
 * @param {object} params - { session_id?, from?, to?, limit?, offset? }
 */
async function fetchPrismScores(params = {}) {
  return get('/v1/intelligence/prism', params);
}

/**
 * GET /v1/intelligence/worst-prompts — fetch lowest-scoring prompts.
 * @param {object} params - { from?, to?, limit? }
 */
async function fetchWorstPrompts(params = {}) {
  return get('/v1/intelligence/worst-prompts', params);
}

/**
 * GET /v1/intelligence/waste — fetch waste detection events.
 * @param {object} params - { pattern?, limit?, offset? }
 */
async function fetchWaste(params = {}) {
  return get('/v1/intelligence/waste', params);
}

/**
 * GET /v1/intelligence/throttle — fetch throttle detection events.
 * @param {object} params - { detector?, limit?, offset? }
 */
async function fetchThrottle(params = {}) {
  return get('/v1/intelligence/throttle', params);
}

/**
 * GET /v1/intelligence/rightsizing — fetch model rightsizing recommendations.
 * @param {object} params - { from?, to? }
 */
async function fetchRightsizing(params = {}) {
  return get('/v1/intelligence/rightsizing', params);
}

/**
 * GET /v1/intelligence/coaching — fetch cross-session coaching insights.
 * @param {object} params - { from?, to? }
 */
async function fetchCoaching(params = {}) {
  return get('/v1/intelligence/coaching', params);
}

/**
 * GET /v1/insights/report — fetch latest insights report.
 */
async function fetchReport() {
  return get('/v1/insights/report', {});
}

/**
 * POST /v1/insights/report/generate — trigger report generation.
 */
async function generateReport() {
  return post('/v1/insights/report/generate', {});
}


// ─── Internal ───

function buildUrl(path, params) {
  if (!INGEST_URL) return null;
  const url = new URL(`${INGEST_URL}${path}`);
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }
  return url;
}

function get(path, params, timeoutMs = 10000) {
  if (!GCK_KEY) {
    debug(`SKIP GET ${path}: no API key`);
    return Promise.resolve(fail('no_api_key'));
  }
  if (!INGEST_URL) {
    debug(`SKIP GET ${path}: no ingest URL`);
    return Promise.resolve(fail('no_ingest_url'));
  }

  const url = buildUrl(path, params);
  if (!url) return Promise.resolve(fail('no_ingest_url'));

  const transport = url.protocol === 'https:' ? https : http;
  debug(`GET ${url.href}`);

  return new Promise((resolve) => {
    const req = transport.request(url, {
      method: 'GET',
      headers: { 'x-api-key': GCK_KEY },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        debug(`RESPONSE GET ${path}: status=${res.statusCode} body_length=${body.length}`);
        if (res.statusCode !== 200) {
          resolve(fail('http_error', { status: res.statusCode }));
          return;
        }
        try {
          resolve(ok(JSON.parse(body)));
        } catch {
          resolve(fail('parse_error'));
        }
      });
    });

    req.on('error', (err) => {
      debug(`ERROR GET ${path}: ${err.message}`);
      resolve(fail('network_error', { message: err.message }));
    });
    req.on('timeout', () => {
      debug(`TIMEOUT GET ${path}: ${timeoutMs}ms`);
      req.destroy();
      resolve(fail('timeout'));
    });
    req.end();
  });
}

function post(path, data, timeoutMs = 30000) {
  if (!GCK_KEY) {
    debug(`SKIP POST ${path}: no API key`);
    return Promise.resolve(fail('no_api_key'));
  }
  if (!INGEST_URL) {
    debug(`SKIP POST ${path}: no ingest URL`);
    return Promise.resolve(fail('no_ingest_url'));
  }

  const url = buildUrl(path, {});
  if (!url) return Promise.resolve(fail('no_ingest_url'));

  const payload = JSON.stringify(data);
  const transport = url.protocol === 'https:' ? https : http;
  debug(`POST ${url.href} payload_length=${payload.length}`);

  return new Promise((resolve) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': GCK_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        debug(`RESPONSE POST ${path}: status=${res.statusCode}`);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve(fail('http_error', { status: res.statusCode }));
          return;
        }
        try {
          resolve(ok(body ? JSON.parse(body) : {}));
        } catch {
          resolve(ok({}));
        }
      });
    });

    req.on('error', (err) => {
      debug(`ERROR POST ${path}: ${err.message}`);
      resolve(fail('network_error', { message: err.message }));
    });
    req.on('timeout', () => {
      debug(`TIMEOUT POST ${path}: ${timeoutMs}ms`);
      req.destroy();
      resolve(fail('timeout'));
    });
    req.write(payload);
    req.end();
  });
}

module.exports = {
  fetchTelemetryLogs,
  fetchPrismScores,
  fetchWorstPrompts,
  fetchWaste,
  fetchThrottle,
  fetchRightsizing,
  fetchCoaching,
  fetchReport,
  generateReport,
};
