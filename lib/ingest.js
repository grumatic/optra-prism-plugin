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
const { validHostPromptId } = require('./host-prompt-id');

const debug = createDebug('ingest');
const MAX_CLASSIFICATION_BODY_BYTES = 4 * 1024;
const MAX_CAPTURED_RESPONSE_BODY_BYTES = MAX_CLASSIFICATION_BODY_BYTES + 1;

function runtimeEnv() {
  return require('./env');
}

// Shared by sendPrompt and sendResponse: forwards the caller's truncation
// evidence for the untruncated body, when the caller supplied it.
// Requires an ingest service that has deployed the matching DTO fields: an
// older server built with #[serde(deny_unknown_fields)] rejects the whole
// request over an unrecognized field, not just this one, so the server-side
// change must ship and be live before this plugin version is distributed.
function applyTruncationEvidence(body, payload) {
  if (Number.isSafeInteger(payload.original_char_count) && payload.original_char_count >= 0) {
    body.original_char_count = payload.original_char_count;
  }
  if (typeof payload.untruncated_sha256 === 'string' && /^[a-f0-9]{64}$/.test(payload.untruncated_sha256)) {
    body.untruncated_sha256 = payload.untruncated_sha256;
  }
  if (typeof payload.truncated === 'boolean') body.truncated = payload.truncated;
}

/**
 * POST /v1/prompts — capture a user prompt.
 * @param {{ prompt_text: string, source?: string, tool_session_id?: string, client_event_id?: string, cwd?: string, metadata?: object, host_prompt_id?: string, original_char_count?: number, untruncated_sha256?: string, truncated?: boolean }} payload
 * @param {{ deadline?: number }} [options]
 * @returns {Promise<{ status: number, body: string }>}
 */
async function sendPrompt(payload, options = {}) {
  const hasHostPromptId = payload
    && typeof payload === 'object'
    && Object.hasOwn(payload, 'host_prompt_id');
  if (hasHostPromptId && !validHostPromptId(payload.host_prompt_id)) {
    throw new TypeError('sendPrompt requires a valid host_prompt_id when provided');
  }
  const body = {
    prompt_text: payload.prompt_text || '',
    source: payload.source || 'claude-code',
    tool_session_id: payload.tool_session_id || '',
  };
  if (payload.client_event_id) body.client_event_id = payload.client_event_id;
  // Key order matches frozenPayload in submit-handler.js. No runtime code
  // depends on this order; the enforcement point is the frozenPayloadHash
  // assertion in test/hooks-output.test.js, which compares
  // JSON.stringify(payload) against JSON.stringify(this body) and only
  // passes when the two objects serialize identically.
  applyTruncationEvidence(body, payload);
  if (payload.cwd) body.cwd = payload.cwd;
  if (payload.metadata) body.metadata = payload.metadata;
  if (hasHostPromptId) body.host_prompt_id = payload.host_prompt_id;
  if (
    typeof payload.submitted_at === 'string'
    && Number.isFinite(Date.parse(payload.submitted_at))
  ) body.submitted_at = payload.submitted_at;
  return post('/v1/prompts', body, options);
}


/**
 * POST /v1/prompts/response — capture an assistant response.
 * A response must be bound to the captured prompt, never merely a session.
 * @param {{ client_event_id: string, prompt_id: string, response_operation_id: string, tool_session_id?: string, response_text: string, elapsed_ms?: number, input_tokens?: number, output_tokens?: number, cache_read_tokens?: number, cache_creation_tokens?: number, model?: string, cost_usd?: number, cost_catalog_revision?: number, cost_kind?: string, host_prompt_id?: string, original_char_count?: number, untruncated_sha256?: string, truncated?: boolean }} payload
 * @param {{ deadline?: number }} [options]
 * @returns {Promise<{ status: number, body: string }>}
 */
async function sendResponse(payload, options = {}) {
  const clientEventId = typeof payload.client_event_id === 'string' && payload.client_event_id.length > 0
    ? payload.client_event_id
    : null;
  const promptId = validServerPromptId(payload.prompt_id) ? payload.prompt_id : null;
  const responseOperationId = typeof payload.response_operation_id === 'string'
    && payload.response_operation_id.length > 0
    && payload.response_operation_id.length <= 255
    ? payload.response_operation_id
    : null;
  if (!clientEventId || !promptId || !responseOperationId) {
    throw new TypeError('sendResponse requires client_event_id, server prompt_id, and response_operation_id');
  }

  const body = {
    tool_session_id: payload.tool_session_id || '',
    response_text: payload.response_text || '',
    client_event_id: clientEventId,
    prompt_id: promptId,
    response_operation_id: responseOperationId,
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
  if (payload.host_prompt_id) body.host_prompt_id = payload.host_prompt_id;
  applyTruncationEvidence(body, payload);
  return post('/v1/prompts/response', body, options);
}

/**
 * POST /v1/git-evidence — report a committed change observation.
 * @param {object} payload the wire event object (already snake_case)
 * @param {{ deadline?: number }} [options]
 * @returns {Promise<{ status: number, body: string, retryAfterSeconds: number|null }>}
 */
async function sendGitEvidence(payload, options = {}) {
  const { canonicalJson, GIT_EVIDENCE_ENDPOINT_PATH } = require('./git-evidence-contract');
  return post(GIT_EVIDENCE_ENDPOINT_PATH, payload, { ...options, preSerialized: canonicalJson(payload) });
}

/**
 * POST /v1/prompt-evidence — capture a standalone producer occurrence.
 * The endpoint is deliberately separate from prompt/response ingestion.
 * @param {{ schema_version: number, client_event_id: string, source_session_id: string, host_prompt_id: string, tool_use_id: string, producer_evidence: object, recipient: string, message_byte_count: number, message_sha256: string, host_success: object }} payload
 * @param {{ deadline?: number }} [options]
 * @returns {Promise<{ status: number, body: string }>}
 */
async function sendPromptEvidence(payload, options = {}) {
  if (!payload || typeof payload !== 'object'
    || payload.schema_version !== 1
    || typeof payload.client_event_id !== 'string'
    || !/^[a-f0-9]{64}$/.test(payload.client_event_id)
    || typeof payload.source_session_id !== 'string'
    || typeof payload.host_prompt_id !== 'string'
    || typeof payload.tool_use_id !== 'string'
    || typeof payload.recipient !== 'string'
    || !Number.isSafeInteger(payload.message_byte_count)
    || !/^[a-f0-9]{64}$/.test(payload.message_sha256)
    || !payload.host_success || typeof payload.host_success !== 'object' || Array.isArray(payload.host_success)
    || !payload.producer_evidence
    || typeof payload.producer_evidence !== 'object'
    || Array.isArray(payload.producer_evidence)) {
    throw new TypeError('sendPromptEvidence requires a deterministic client_event_id and producer_evidence');
  }
  return post('/v1/prompt-evidence', {
    schema_version: payload.schema_version,
    client_event_id: payload.client_event_id,
    source_session_id: payload.source_session_id,
    host_prompt_id: payload.host_prompt_id,
    tool_use_id: payload.tool_use_id,
    producer_evidence: payload.producer_evidence,
    recipient: payload.recipient,
    message_byte_count: payload.message_byte_count,
    message_sha256: payload.message_sha256,
    host_success: payload.host_success,
  }, options);
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

// Retry-After as an integer count of seconds in [1, 3600], otherwise null.
// Only the delta-seconds form is honored; an HTTP-date value is not parsed.
function parseRetryAfterSeconds(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3600 ? seconds : null;
}

function normalizedMediaType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const mediaType = raw.split(';', 1)[0].trim().toLowerCase();
  return /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mediaType)
    ? mediaType
    : null;
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


function post(path, data, options = {}) {
  const { API_KEY, INGEST_URL } = runtimeEnv();
  if (!INGEST_URL || !API_KEY) {
    debug(`SKIP ${path}: INGEST_URL=${INGEST_URL || '(empty)'} API_KEY=${API_KEY ? 'set' : '(empty)'}`);
    return Promise.resolve({ status: 0, body: 'not configured', mediaType: null });
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 3000;
  const deadline = Number.isFinite(options.deadline) ? options.deadline : undefined;
  const remainingMs = deadline === undefined ? timeoutMs : deadline - Date.now();
  if (remainingMs <= 0) return Promise.reject(new Error('deadline exceeded'));

  const payload = typeof options.preSerialized === 'string' ? options.preSerialized : JSON.stringify(data);
  const url = new URL(`${INGEST_URL.replace(/\/+$/, '')}${path}`);
  const transport = url.protocol === 'https:' ? https : http;
  const requestTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));

  debug(`POST ${url.href} payload_length=${payload.length}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      callback(value);
    };
    const req = transport.request(url, {
      method: 'POST',
      headers: addPluginVersionHeader({
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      }),
      timeout: requestTimeoutMs,
    }, (res) => {
      let bodyBytes = 0;
      let capturedBytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bodyBytes += bytes.length;
        if (capturedBytes >= MAX_CAPTURED_RESPONSE_BODY_BYTES) return;
        const captured = bytes.subarray(0, MAX_CAPTURED_RESPONSE_BODY_BYTES - capturedBytes);
        chunks.push(captured);
        capturedBytes += captured.length;
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const details = responseDebugDetails(body);
        debug(`RESPONSE ${path}: status=${res.statusCode} body_length=${bodyBytes} id=${details.id} error_code=${details.errorCode}`);
        settle(resolve, {
          status: res.statusCode,
          body,
          bodyBytes,
          bodyTruncated: bodyBytes > MAX_CAPTURED_RESPONSE_BODY_BYTES,
          mediaType: normalizedMediaType(res.headers['content-type']),
          retryAfterSeconds: parseRetryAfterSeconds(res.headers['retry-after']),
        });
      });
    });

    req.on('error', (err) => {
      debug(`ERROR ${path}: ${err.message} (code=${err.code || 'none'})`);
      settle(reject, err);
    });
    req.on('timeout', () => {
      debug(`TIMEOUT ${path}: ${requestTimeoutMs}ms exceeded`);
      req.destroy();
      settle(reject, new Error('timeout'));
    });
    if (deadline !== undefined) {
      deadlineTimer = setTimeout(() => {
        debug(`DEADLINE ${path}: replay budget exceeded`);
        req.destroy();
        settle(reject, new Error('deadline exceeded'));
      }, remainingMs);
    }
    req.write(payload);
    req.end();
  });
}

module.exports = {
  MAX_CLASSIFICATION_BODY_BYTES,
  sendPrompt,
  sendResponse,
  sendGitEvidence,
  sendPromptEvidence,
  healthCheck,
  fetchRealtimeSubSessions,
  fetchTodaySummary,
  normalizedMediaType,
};
