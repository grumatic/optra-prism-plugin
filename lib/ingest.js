/**
 * Ingest service client.
 * Sends prompts and responses to the Prism ingest service.
 *
 * Used by: hooks (submit-handler, stop-handler) and commands (status).
 */

const https = require('https');
const http = require('http');
const { isSupportedIngestUrl } = require('./config');
const { createDebug } = require('./debug');
const { addPluginVersionHeader } = require('./plugin-version');
const { validServerPromptId } = require('./session');

const debug = createDebug('ingest');

function runtimeEnv() {
  return require('./env');
}

/**
 * POST /v1/prompts — capture a user prompt.
 * @param {{ prompt_text: string, source?: string, tool_session_id?: string, client_event_id?: string, cwd?: string, metadata?: object }} payload
 * @returns {Promise<{ status: number, body: string }>}
 */
async function sendPrompt(payload) {
  const body = {
    prompt_text: payload.prompt_text || '',
    source: payload.source || 'claude-code',
    tool_session_id: payload.tool_session_id || '',
  };
  if (payload.client_event_id) body.client_event_id = payload.client_event_id;
  if (payload.cwd) body.cwd = payload.cwd;
  if (payload.metadata) body.metadata = payload.metadata;
  return post('/v1/prompts', body);
}

/**
 * POST /v1/prompts/response — capture an assistant response.
 * A response must be bound to the captured prompt, never merely a session.
 * @param {{ client_event_id: string, prompt_id: string, tool_session_id?: string, response_text: string, elapsed_ms?: number, input_tokens?: number, output_tokens?: number, cache_read_tokens?: number, cache_creation_tokens?: number, model?: string, cost_usd?: number, cost_catalog_revision?: number, cost_kind?: string }} payload
 * @returns {Promise<{ status: number, body: string }>}
 */
async function sendResponse(payload) {
  const clientEventId = typeof payload.client_event_id === 'string' && payload.client_event_id.length > 0
    ? payload.client_event_id
    : null;
  const promptId = validServerPromptId(payload.prompt_id) ? payload.prompt_id : null;
  if (!clientEventId || !promptId) {
    throw new TypeError('sendResponse requires client_event_id and server prompt_id');
  }

  const body = {
    tool_session_id: payload.tool_session_id || '',
    response_text: payload.response_text || '',
    client_event_id: clientEventId,
    prompt_id: promptId,
  };
  if (payload.elapsed_ms) body.elapsed_ms = payload.elapsed_ms;
  if (payload.input_tokens != null) body.input_tokens = payload.input_tokens;
  if (payload.output_tokens != null) body.output_tokens = payload.output_tokens;
  if (payload.cache_read_tokens != null) body.cache_read_tokens = payload.cache_read_tokens;
  if (payload.cache_creation_tokens != null) body.cache_creation_tokens = payload.cache_creation_tokens;
  if (payload.model) body.model = payload.model;
  const hasCostProvenance = Number.isFinite(payload.cost_usd)
    && payload.cost_usd >= 0
    && Number.isSafeInteger(payload.cost_catalog_revision)
    && payload.cost_catalog_revision > 0
    && payload.cost_kind === 'public_list_price_estimate';
  if (hasCostProvenance) {
    body.cost_usd = payload.cost_usd;
    body.cost_catalog_revision = payload.cost_catalog_revision;
    body.cost_kind = payload.cost_kind;
  }
  return post('/v1/prompts/response', body);
}
/**
 * GET realtime Score v3 sub-sessions for a Claude session.
 * @param {{ claudeSessionId: string, limit: number }} options
 * @returns {Promise<Array|null>}
 */
function fetchRealtimeSubSessions({ claudeSessionId, limit }) {
  const query = new URLSearchParams({
    claude_session_id: typeof claudeSessionId === 'string' ? claudeSessionId : '',
    limit: String(limit),
  });
  return getJson(`/v1/score_v3/realtime/sub-sessions?${query}`);
}

/**
 * GET today's Score v3 narrative summary.
 * @param {{ date: string }} options
 * @returns {Promise<object|null>}
 */
function fetchTodaySummary({ date }) {
  const query = new URLSearchParams({ date: typeof date === 'string' ? date : '' });
  return getJson(`/v1/score_v3/today-summary?${query}`);
}

/**
 * GET /health — check ingest service connectivity.
 * @returns {Promise<{ok: boolean, reachable: boolean, httpStatus: number|null, error: string|null}>}
 */
async function healthCheck(ingestUrl) {
  const selectedUrl = arguments.length > 0 ? ingestUrl : runtimeEnv().INGEST_URL;
  if (!isSupportedIngestUrl(selectedUrl)) {
    return {
      ok: false,
      reachable: false,
      httpStatus: null,
      error: 'ingest URL is missing or unsupported',
    };
  }

  try {
    const url = new URL(`${selectedUrl.replace(/\/+$/, '')}/health`);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = transport.request(url, { method: 'GET', timeout: 3000 }, (res) => {
        res.resume();
        const httpStatus = res.statusCode || null;
        resolve({
          ok: httpStatus !== null && httpStatus >= 200 && httpStatus < 300,
          reachable: true,
          httpStatus,
          error: null,
        });
      });
      req.on('error', (error) => resolve({
        ok: false,
        reachable: false,
        httpStatus: null,
        error: error.message,
      }));
      req.on('timeout', () => {
        req.destroy();
        resolve({
          ok: false,
          reachable: false,
          httpStatus: null,
          error: 'request timed out',
        });
      });
      req.end();
    });
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      httpStatus: null,
      error: error.message,
    };
  }
}

// ─── Internal ───

function responseDebugDetails(body) {
  let id = '';
  let errorCode = '';
  try {
    const parsed = JSON.parse(body);
    const responseId = parsed.id || parsed.prompt_id || (parsed.data && (parsed.data.id || parsed.data.prompt_id));
    const responseError = parsed.error && parsed.error.code ? parsed.error.code : parsed.code;
    if (typeof responseId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(responseId)) id = responseId;
    if (typeof responseError === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(responseError)) errorCode = responseError;
  } catch {}
  return { id: id || 'none', errorCode: errorCode || 'none' };
}
function getJson(path, timeoutMs = 3000) {
  const { API_KEY, INGEST_URL } = runtimeEnv();
  if (!INGEST_URL || !API_KEY) {
    debug(`SKIP ${path}: INGEST_URL=${INGEST_URL || '(empty)'} API_KEY=${API_KEY ? 'set' : '(empty)'}`);
    return Promise.resolve(null);
  }

  try {
    const url = new URL(`${INGEST_URL.replace(/\/+$/, '')}${path}`);
    const transport = url.protocol === 'https:' ? https : http;
    debug(`GET ${url.href}`);

    return new Promise((resolve) => {
      let req;
      try {
        req = transport.request(url, {
          method: 'GET',
          headers: addPluginVersionHeader({ 'x-api-key': API_KEY }),
          timeout: timeoutMs,
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              debug(`RESPONSE ${path}: status=${res.statusCode} body_length=${Buffer.byteLength(body)}`);
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch {
              debug(`RESPONSE ${path}: invalid JSON body_length=${Buffer.byteLength(body)}`);
              resolve(null);
            }
          });
        });
        req.on('error', (err) => {
          debug(`ERROR ${path}: ${err.message} (code=${err.code || 'none'})`);
          resolve(null);
        });
        req.on('timeout', () => {
          debug(`TIMEOUT ${path}: ${timeoutMs}ms exceeded`);
          req.destroy();
          resolve(null);
        });
        req.end();
      } catch (err) {
        debug(`ERROR ${path}: ${(err && err.message) || err}`);
        resolve(null);
      }
    });
  } catch {
    return Promise.resolve(null);
  }
}


function post(path, data, timeoutMs = 3000) {
  const { API_KEY, INGEST_URL } = runtimeEnv();
  if (!INGEST_URL || !API_KEY) {
    debug(`SKIP ${path}: INGEST_URL=${INGEST_URL || '(empty)'} API_KEY=${API_KEY ? 'set' : '(empty)'}`);
    return Promise.resolve({ status: 0, body: 'not configured' });
  }

  const payload = JSON.stringify(data);
  const url = new URL(`${INGEST_URL.replace(/\/+$/, '')}${path}`);
  const transport = url.protocol === 'https:' ? https : http;

  debug(`POST ${url.href} payload_length=${payload.length}`);

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: addPluginVersionHeader({
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      }),
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const details = responseDebugDetails(body);
        debug(`RESPONSE ${path}: status=${res.statusCode} body_length=${Buffer.byteLength(body)} id=${details.id} error_code=${details.errorCode}`);
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', (err) => {
      debug(`ERROR ${path}: ${err.message} (code=${err.code || 'none'})`);
      reject(err);
    });
    req.on('timeout', () => {
      debug(`TIMEOUT ${path}: ${timeoutMs}ms exceeded`);
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendPrompt, sendResponse, healthCheck, fetchRealtimeSubSessions, fetchTodaySummary };
