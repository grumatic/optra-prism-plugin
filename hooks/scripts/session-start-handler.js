#!/usr/bin/env node
'use strict';

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

// Refreshes the git-evidence/v1 capability at most once every five minutes,
// then drains the backlog when the gate is open. Runs after recoverOutbox so
// a slow config endpoint can never delay prompt/response recovery.
async function drainEvidenceBacklog(report) {
  try {
    const { refreshCapability, capabilityAllowsEvidence } = require('../../lib/git-evidence-capability');
    const { drainEvidence } = require('../../lib/git-evidence-delivery');
    const snapshot = await refreshCapability();
    if (capabilityAllowsEvidence(snapshot)) {
      await drainEvidence({ limit: 8, maxElapsedMs: 750 });
    }
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
  await resumeEvidence(data.session_id, report);
  await drainEvidenceBacklog(report);

  try {
    const { collectPluginNotices } = require('../../lib/plugin-activation');
    const result = await collectPluginNotices({
      source: data.source,
      pluginRoot: process.env.PRISM_PLUGIN_ROOT,
      dataDir: process.env.CLAUDE_PLUGIN_DATA,
      projectDir: process.env.CLAUDE_PROJECT_DIR || data.cwd,
    });
    if (result.notices.length > 0) {
      process.stdout.write(`${JSON.stringify({
        systemMessage: result.notices.join('\n').slice(0, MAX_SYSTEM_MESSAGE_LENGTH),
      })}\n`);
    }
  } catch {}
  return 0;
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = 0;
  });
}

module.exports = {
  advanceLifecycle,
  recoverOutbox,
  resumeEvidence,
  drainEvidenceBacklog,
  main,
  readHookStdin,
};
