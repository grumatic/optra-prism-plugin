/**
 * Setup-completion ping — flips the dashboard activation funnel from
 * "waiting for /prism:setup" to "key configured, restart Claude Code"
 * the moment the slash command finishes.
 *
 * Ingest auth resolves developer_id and org_id from the API key, so the
 * body cross-checks are optional. We POST a minimal body and rely on the
 * server to fill in the IDs from auth.
 *
 * Best-effort: any error is swallowed so /prism:setup never breaks because
 * the dashboard or ingest is unreachable.
 */

const config = require('./config');
const { isSupportedApiKey } = require('./api-key');
let pkg;
try {
  pkg = require('../package.json');
} catch {
  pkg = { version: 'unknown' };
}

async function notifySetupComplete(apiKey) {
  if (!isSupportedApiKey(apiKey)) return false;
  try {
    // ensureCache returns the resolved URL bundle; reusing the same code
    // path that step 4 of /prism:setup already uses, so the URL is fresh
    // for the just-configured key.
    const cache = await config.ensureCache(apiKey);
    const ingestUrl = (cache && cache.ingest_url) || null;
    if (!ingestUrl) return false;
    const url = `${ingestUrl.replace(/\/$/, '')}/v1/setup-complete`;
    const body = JSON.stringify({ plugin_version: pkg.version });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { notifySetupComplete };
