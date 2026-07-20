/**
 * Best-effort setup-completion notification.
 */

const { getConfig, isSupportedIngestUrl } = require('./config');
const { hasApiKey } = require('./api-key');

let pkg;
try {
  pkg = require('../package.json');
} catch {
  pkg = { version: 'unknown' };
}

async function notifySetupComplete(apiKey) {
  if (!hasApiKey(apiKey)) {
    return { ok: false, httpStatus: null, error: 'API key is missing' };
  }

  try {
    const ingestUrl = getConfig().ingest_url;
    if (!isSupportedIngestUrl(ingestUrl)) {
      return { ok: false, httpStatus: null, error: 'ingest_url is missing or unsupported' };
    }

    const url = `${ingestUrl.replace(/\/+$/, '')}/v1/setup-complete`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plugin_version: pkg.version }),
      signal: AbortSignal.timeout(3000),
    });
    const httpStatus = Number.isInteger(res.status) ? res.status : null;
    return {
      ok: res.ok,
      httpStatus,
      error: res.ok ? null : `HTTP ${httpStatus || 'unknown'}`,
    };
  } catch (error) {
    return { ok: false, httpStatus: null, error: error.message };
  }
}

module.exports = { notifySetupComplete };
