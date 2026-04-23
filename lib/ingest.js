/**
 * Ingest service client.
 * Sends prompts and responses to the Prism ingest service.
 *
 * Used by: hooks (submit-handler, stop-handler) and commands (status).
 */

const https = require('https');
const http = require('http');
const { GCK_KEY, INGEST_URL } = require('./env');
const { createDebug } = require('./debug');

const debug = createDebug('ingest');

/**
 * POST /v1/prompts — capture a user prompt.
 * @param {{ prompt_text: string, source?: string, tool_session_id?: string, cwd?: string, metadata?: object }} payload
 * @returns {Promise<{ status: number, body: string }>}
 */
async function sendPrompt(payload) {
  const body = {
    prompt_text: payload.prompt_text || '',
    source: payload.source || 'claude-code',
    tool_session_id: payload.tool_session_id || '',
  };
  if (payload.cwd) body.cwd = payload.cwd;
  if (payload.metadata) body.metadata = payload.metadata;
  return post('/v1/prompts', body);
}

/**
 * POST /v1/prompts/response — capture an assistant response.
 * @param {{
 *   tool_session_id: string,
 *   response_text: string,
 *   elapsed_ms?: number,
 *   input_tokens?: number,
 *   output_tokens?: number,
 *   cost_usd?: number,
 * }} payload
 * @returns {Promise<{ status: number, body: string }>}
 */
async function sendResponse(payload) {
  const body = {
    tool_session_id: payload.tool_session_id || '',
    response_text: payload.response_text || '',
  };
  if (payload.elapsed_ms) body.elapsed_ms = payload.elapsed_ms;
  if (payload.input_tokens != null) body.input_tokens = payload.input_tokens;
  if (payload.output_tokens != null) body.output_tokens = payload.output_tokens;
  if (payload.model) body.model = payload.model;
  if (payload.cost_usd != null) body.cost_usd = payload.cost_usd;
  return post('/v1/prompts/response', body);
}

/**
 * GET /health — check ingest service connectivity.
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  if (!INGEST_URL) return false;
  try {
    const url = new URL(`${INGEST_URL}/health`);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = transport.request(url, { method: 'GET', timeout: 3000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  } catch {
    return false;
  }
}

// ─── Internal ───

function post(path, data, timeoutMs = 10000) {
  if (!INGEST_URL || !GCK_KEY) {
    debug(`SKIP ${path}: INGEST_URL=${INGEST_URL || '(empty)'} GCK_KEY=${GCK_KEY ? 'set' : '(empty)'}`);
    return Promise.resolve({ status: 0, body: 'not configured' });
  }

  const payload = JSON.stringify(data);
  const url = new URL(`${INGEST_URL}${path}`);
  const transport = url.protocol === 'https:' ? https : http;

  debug(`POST ${url.href} payload_length=${payload.length}`);

  return new Promise((resolve, reject) => {
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
        debug(`RESPONSE ${path}: status=${res.statusCode} body=${body.slice(0, 300)}`);
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

module.exports = { sendPrompt, sendResponse, healthCheck };
