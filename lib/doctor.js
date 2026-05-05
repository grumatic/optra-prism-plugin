#!/usr/bin/env node
/**
 * Prism Doctor — diagnostic checks for plugin configuration.
 *
 * Runs 5 checks and outputs JSON to stdout:
 *   1. API Key        — exists and starts with gck_
 *   2. OTEL Scope     — activeScope/installScope consistency
 *   3. Config Cache   — exists, not fallback, not expired, key matches
 *   4. Ingest Connect — HTTP probe against ingest + OTEL endpoints
 *   5. Env Sync       — process.env OTEL vars match expected values
 *
 * CLI: node lib/doctor.js [--project-dir PATH]
 * Exit: 0 = no failures, 1 = at least one failure
 *
 * Does NOT require('./ingest') or require('./env') — avoids module-load-time
 * env capture that breaks standalone CLI invocation.
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const {
  readApiKey,
  buildExpectedOtelEnv,
  detectActiveScope,
  detectInstallScope,
  resolveOtelScope,
  OTEL_KEYS,
} = require('./settings');
const { fetchConfig, getCacheFile } = require('./config');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;
const KEY_MASK_LEN = 12;

// ─── Check 1: API Key ───

function checkApiKey() {
  const key = readApiKey();
  if (!key) {
    return {
      id: 'api-key', name: 'API Key', status: 'fail',
      message: 'No API key configured',
      remediation: 'Run /prism:setup gck_YOUR_KEY',
    };
  }
  if (!key.startsWith('gck_')) {
    return {
      id: 'api-key', name: 'API Key', status: 'fail',
      message: `Invalid key format (expected gck_* prefix, got ${key.substring(0, 4)}...)`,
      remediation: 'API key must start with gck_. Run /prism:setup gck_YOUR_KEY',
    };
  }
  return {
    id: 'api-key', name: 'API Key', status: 'pass',
    message: `${key.substring(0, KEY_MASK_LEN)}...`,
    remediation: null,
  };
}

// ─── Check 2: OTEL Scope ───

function checkOtelScope(projectDir) {
  const { scope: activeScope, warnings: activeWarnings } = detectActiveScope(projectDir);
  const installScope = detectInstallScope(projectDir);
  const resolution = resolveOtelScope(projectDir);
  const allWarnings = [...activeWarnings, ...resolution.warnings];

  const hasSharedLeak = allWarnings.some(w => /shared.*gck_|gck_.*shared|checked in/i.test(w));
  if (hasSharedLeak) {
    return {
      id: 'otel-scope', name: 'OTEL Scope', status: 'fail',
      message: `gck_* key found in shared settings (may be committed to git)`,
      remediation: 'Remove OTEL vars from .claude/settings.json (shared) manually',
    };
  }

  if (activeScope === 'none') {
    return {
      id: 'otel-scope', name: 'OTEL Scope', status: 'fail',
      message: 'No OTEL env vars configured in any scope',
      remediation: 'Run /prism:setup gck_YOUR_KEY',
    };
  }

  if (activeScope === 'both') {
    return {
      id: 'otel-scope', name: 'OTEL Scope', status: 'warn',
      message: 'OTEL vars exist in both user and project scopes',
      remediation: 'Run /prism:setup to consolidate to one scope',
    };
  }

  if (resolution.action === 'repair') {
    return {
      id: 'otel-scope', name: 'OTEL Scope', status: 'warn',
      message: `Scope mismatch: active=${activeScope}, install=${installScope || 'unknown'}`,
      remediation: `Run /prism:setup to repair (will move to ${resolution.targetScope} scope)`,
    };
  }

  return {
    id: 'otel-scope', name: 'OTEL Scope', status: 'pass',
    message: `${activeScope} scope (install: ${installScope || 'auto-detected'})`,
    remediation: null,
  };
}

// ─── Check 3: Config Cache ───

async function checkConfigCache(apiKey) {
  const cacheFile = getCacheFile();
  const autoFixed = [];
  const canAutoFix = apiKey && apiKey.startsWith('gck_');

  async function tryAutoFix() {
    if (!canAutoFix) return null;
    return fetchConfig(apiKey);
  }

  if (!fs.existsSync(cacheFile)) {
    const fetched = await tryAutoFix();
    if (fetched) {
      autoFixed.push('Created missing config cache via fetchConfig()');
      return { id: 'config-cache', name: 'Config Cache', status: 'pass',
        message: 'Cache created (was missing)', remediation: null, autoFixed };
    }
    return { id: 'config-cache', name: 'Config Cache', status: 'warn',
      message: 'Cache file missing and re-fetch failed',
      remediation: 'Run /prism:setup to re-initialize', autoFixed };
  }

  let cache;
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    cache = JSON.parse(raw);
  } catch {
    const fetched = await tryAutoFix();
    if (fetched) {
      autoFixed.push('Replaced corrupt config cache via fetchConfig()');
      return { id: 'config-cache', name: 'Config Cache', status: 'pass',
        message: 'Cache repaired (was corrupt)', remediation: null, autoFixed };
    }
    return { id: 'config-cache', name: 'Config Cache', status: 'fail',
      message: 'Corrupt cache file and re-fetch failed',
      remediation: 'Delete ~/.prism/config-cache.json and run /prism:setup', autoFixed };
  }

  if (cache.source === 'fallback') {
    const fetched = await tryAutoFix();
    if (fetched) {
      autoFixed.push('Upgraded fallback cache to server-confirmed config');
      return { id: 'config-cache', name: 'Config Cache', status: 'pass',
        message: 'Cache upgraded from fallback', remediation: null, autoFixed };
    }
    return { id: 'config-cache', name: 'Config Cache', status: 'warn',
      message: 'Cache contains fallback URLs (config endpoint unreachable)',
      remediation: 'Check network connectivity; re-run /prism:doctor later', autoFixed };
  }

  if (cache.cached_at) {
    const age = Date.now() - new Date(cache.cached_at).getTime();
    if (age > CACHE_TTL_MS) {
      const fetched = await tryAutoFix();
      if (fetched) {
        autoFixed.push('Refreshed expired config cache');
        return { id: 'config-cache', name: 'Config Cache', status: 'pass',
          message: 'Cache refreshed (was expired)', remediation: null, autoFixed };
      }
      return { id: 'config-cache', name: 'Config Cache', status: 'warn',
        message: `Cache expired (age: ${Math.round(age / 3600000)}h)`,
        remediation: 'Check network connectivity; re-run /prism:doctor later', autoFixed };
    }
  }

  if (apiKey && cache.key_prefix) {
    const currentPrefix = apiKey.substring(0, KEY_MASK_LEN);
    if (cache.key_prefix !== currentPrefix) {
      const fetched = await tryAutoFix();
      if (fetched) {
        autoFixed.push('Refreshed cache for new API key');
        return { id: 'config-cache', name: 'Config Cache', status: 'pass',
          message: 'Cache refreshed (key changed)', remediation: null, autoFixed };
      }
      return { id: 'config-cache', name: 'Config Cache', status: 'warn',
        message: 'Cache key_prefix does not match current API key',
        remediation: 'Run /prism:setup with the correct key', autoFixed };
    }
  }

  return { id: 'config-cache', name: 'Config Cache', status: 'pass',
    message: `Valid (env: ${cache.environment || 'unknown'})`,
    remediation: null, autoFixed };
}

// ─── Check 4: Ingest Connectivity ───

function httpProbe(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        resolve(false);
        return;
      }
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });
}

async function checkIngestConnectivity() {
  const results = [];

  let ingestUrl = null;
  try {
    const raw = fs.readFileSync(getCacheFile(), 'utf8');
    const cache = JSON.parse(raw);
    ingestUrl = cache.ingest_url || null;
  } catch {}
  if (!ingestUrl) ingestUrl = 'https://ingest.prism.optra-ai.com';

  const ingestOk = await httpProbe(`${ingestUrl}/health`, PROBE_TIMEOUT_MS);
  results.push({ target: 'ingest', status: ingestOk ? 'pass' : 'fail', url: ingestUrl });

  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (otelEndpoint) {
    const otelOk = await httpProbe(otelEndpoint, PROBE_TIMEOUT_MS);
    results.push({ target: 'otel', status: otelOk ? 'pass' : 'warn', url: otelEndpoint });

    try {
      const ingestBase = new URL(ingestUrl).origin;
      const otelBase = new URL(otelEndpoint).origin;
      if (ingestBase !== otelBase) {
        results.push({
          target: 'drift', status: 'warn',
          message: `Ingest base (${ingestBase}) != OTEL base (${otelBase})`,
        });
      }
    } catch {}
  }

  const hasFail = results.some(r => r.status === 'fail');
  const hasWarn = results.some(r => r.status === 'warn');
  const status = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
  const messages = results.map(r =>
    `${r.target}: ${r.status}${r.url ? ` (${r.url})` : ''}${r.message ? ` — ${r.message}` : ''}`
  );

  return {
    id: 'ingest-connectivity', name: 'Ingest Connectivity', status,
    message: messages.join('; '),
    remediation: hasFail
      ? 'Check network connectivity and verify ingest URL in ~/.prism/config-cache.json'
      : hasWarn
        ? 'OTEL endpoint may be unreachable; restart Claude Code if settings changed'
        : null,
  };
}

// ─── Check 5: Process Env Sync ───

function checkProcessEnvSync() {
  const expected = buildExpectedOtelEnv();
  if (!expected) {
    return {
      id: 'env-sync', name: 'Process Env Sync', status: 'pass',
      message: 'Skipped — no valid config (see Check 1/3)',
      remediation: null,
    };
  }

  const mismatches = [];
  for (const [key, val] of Object.entries(expected.otelEnv)) {
    if (process.env[key] !== val) {
      mismatches.push(key);
    }
  }

  if (mismatches.length > 0) {
    return {
      id: 'env-sync', name: 'Process Env Sync', status: 'warn',
      message: `${mismatches.length} env var(s) out of sync: ${mismatches.join(', ')}`,
      remediation: 'Restart Claude Code to apply updated settings',
    };
  }

  return {
    id: 'env-sync', name: 'Process Env Sync', status: 'pass',
    message: `All ${OTEL_KEYS.length} OTEL env vars in sync`,
    remediation: null,
  };
}

// ─── Runner ───

async function runChecks({ projectDir } = {}) {
  const allAutoFixed = [];

  const apiKeyResult = checkApiKey();
  const apiKey = readApiKey();

  const scopeResult = checkOtelScope(projectDir);

  const cacheResult = await checkConfigCache(apiKey);
  if (cacheResult.autoFixed) allAutoFixed.push(...cacheResult.autoFixed);
  delete cacheResult.autoFixed;

  const connectResult = await checkIngestConnectivity();

  const envResult = checkProcessEnvSync();

  const checks = [apiKeyResult, scopeResult, cacheResult, connectResult, envResult];
  const summary = {
    passed: checks.filter(c => c.status === 'pass').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    failed: checks.filter(c => c.status === 'fail').length,
  };

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    checks,
    summary,
    autoFixed: allAutoFixed,
  };
}

// ─── CLI ───

function parseProjectDir(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-dir' && argv[i + 1]) return argv[i + 1];
  }
  return process.env.CLAUDE_PROJECT_DIR || null;
}

if (require.main === module) {
  const projectDir = parseProjectDir(process.argv.slice(2));
  runChecks({ projectDir }).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.summary.failed > 0 ? 1 : 0);
  }).catch(err => {
    process.stderr.write(`[prism:doctor] Fatal: ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = { runChecks };
