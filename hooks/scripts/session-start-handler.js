#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const MAX_SYSTEM_MESSAGE_LENGTH = 10_000;

function readHookStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(input)); } catch { resolve({}); }
    });
  });
}

async function advanceLifecycle(data, report) {
  const session = require('../../lib/session');
  const sessionId = data && data.session_id;
  const source = data && data.source;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 1024) {
    report('invalid session identity');
    return false;
  }
  if (typeof source !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(source)) {
    report('invalid source');
    return false;
  }

  if (!session.advanceBarrier(sessionId, 'lifecycle')) {
    report('lock unavailable');
    return false;
  }
  try { session.cleanupStaleSessions(); } catch {}
  const cwd = data && data.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    try {
      const { collectGitContext } = require('../../lib/git');
      const context = await collectGitContext(cwd);
      session.writeGit(sessionId, context);
    } catch {
      report('git context refresh failed');
    }
  }
  return true;
}

async function recoverOutbox(report) {
  try {
    const { drain } = require('../../lib/response-outbox');
    const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
    await drain(deliverOutboxEntry, { limit: 32, maxElapsedMs: 2000 });
  } catch {
    report('outbox recovery failed');
  }
}

// Resolves this session's pending git-capture marker, if any. Never affects
// the hook's exit code or stdout.
async function resumeEvidence(sessionId, report) {
  try {
    const { resumeEvidenceCapture } = require('./stop-handler');
    await resumeEvidenceCapture(sessionId);
  } catch {
    report('git evidence resume failed');
  }
}

// Refreshes the git-evidence/v1 capability at most once every five minutes.
// Runs after recoverOutbox so a slow config endpoint can never delay
// prompt/response recovery, and before resume so a missing cache does not
// drop the marker resume is about to collect.
async function refreshEvidenceCapability(report) {
  try {
    await require('../../lib/git-evidence-capability').refreshCapability();
  } catch {
    report('git evidence capability refresh failed');
  }
}

// Drains the backlog. drainEvidence checks the delivery gate itself (and
// refreshes only when due, which the refresh above has just done).
async function drainEvidenceBacklog(report) {
  try {
    const { drainEvidence } = require('../../lib/git-evidence-delivery');
    await drainEvidence({ limit: 8, maxElapsedMs: 750 });
  } catch {
    report('git evidence drain failed');
  }
}

async function main() {
  const data = await readHookStdin();
  let debug = false;
  try {
    debug = require('../../lib/config').getConfig().debug === true;
  } catch {}
  const report = (reason) => {
    if (debug) process.stderr.write(`[Prism debug] SessionStart barrier skipped: ${reason}\n`);
  };

  let validLifecycle = false;
  try {
    validLifecycle = await advanceLifecycle(data, report);
  } catch {
    report('helper failure');
  }
  if (!validLifecycle) return 0;
  await recoverOutbox(report);
  await refreshEvidenceCapability(report);
  await resumeEvidence(data.session_id, report);
  await drainEvidenceBacklog(report);

  try {
    const { collectPluginNotices } = require('../../lib/plugin-activation');
    const result = await collectPluginNotices({
      source: data.source,
      pluginRoot: process.env.PRISM_PLUGIN_ROOT,
      dataDir: process.env.CLAUDE_PLUGIN_DATA,
      projectDir: process.env.CLAUDE_PROJECT_DIR || data.cwd,
      sessionId: data.session_id,
    });
    if (result.notices.length > 0) {
      process.stdout.write(`${JSON.stringify({
        systemMessage: result.notices.join('\n').slice(0, MAX_SYSTEM_MESSAGE_LENGTH),
      })}\n`);
    }
  } catch {}
  return 0;
}

function resolvePluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..');
}

// Returns the validated ingest URL, or null after writing the reason to stderr.
function checkConfig() {
  try {
    const { getConfig, isSupportedIngestUrl } = require('../../lib/config');
    const { verifyBinding } = require('../../lib/binding');
    const config = getConfig();
    if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
      process.stderr.write('\n[Prism] No API key configured.\n');
      process.stderr.write('        Run: /prism:setup YOUR_KEY\n\n');
      return null;
    }
    if (!isSupportedIngestUrl(config.ingest_url)) {
      process.stderr.write('[Prism] ingest_url in ~/.prism/config.json is missing or unsupported.\n');
      process.stderr.write('        Use HTTPS, or HTTP on loopback, without credentials, query, or fragment.\n');
      process.stderr.write('        Run /prism:setup YOUR_KEY, or set it with /prism:config, then retry.\n');
      return null;
    }
    const binding = verifyBinding(config);
    if (binding.status === 'mismatch') {
      process.stderr.write('\n[Prism] API key is not bound to the configured ingest_url.\n');
      process.stderr.write(`        Key was verified for ${binding.boundHost || 'another host'}; ingest_url now points to ${binding.currentHost || 'an unreadable host'}.\n`);
      process.stderr.write('        Telemetry stays off until the pair matches. Run: /prism:setup YOUR_KEY\n\n');
      return null;
    }
    return config.ingest_url;
  } catch (error) {
    process.stderr.write(`[Prism] Unable to read ~/.prism/config.json: ${error.message}\n`);
    return null;
  }
}

// The refresh runs in its own process that the hook never waits for: all stdio
// is closed so no inherited pipe keeps the hook alive.
function startModelCatalogRefresh() {
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'model-catalog-refresh.js')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// Hook entry point: the lifecycle work never affects the config check, which
// always ends with exit code 0.
async function startup() {
  process.env.PRISM_PLUGIN_ROOT = resolvePluginRoot();
  try {
    await main();
  } catch {}

  const ingestUrl = checkConfig();
  if (ingestUrl === null) return 0;

  if (ingestUrl && process.env.CLAUDE_PLUGIN_DATA) startModelCatalogRefresh();

  process.stderr.write('[Prism] Session started — Prism API key present\n');
  process.stderr.write('[Prism] Endpoints:\n');
  process.stderr.write(`        Ingest:    ${ingestUrl}\n`);
  return 0;
}

if (require.main === module) {
  startup().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = 0;
  });
}

module.exports = {
  startup,
  checkConfig,
  advanceLifecycle,
  recoverOutbox,
  resumeEvidence,
  drainEvidenceBacklog,
  main,
  readHookStdin,
};
