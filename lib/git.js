'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  sanitizeRemoteUrl,
  parseRemoteUrl,
  buildPromptGitMetadata,
  rootFingerprint,
  BRANCH_MAX_BYTES,
} = require('./git-evidence-contract');

const DEADLINE_MS = 250;
const MAX_BUFFER = 64 * 1024;

function timestamp() {
  return new Date().toISOString();
}

function gitOutputBytes(stdout, stderr) {
  return Buffer.byteLength(stdout || '', 'utf8') + Buffer.byteLength(stderr || '', 'utf8');
}

function outputBudgetExceeded() {
  return Object.assign(new Error('git output budget exceeded'), { code: 'EMAXBUFFER' });
}

function runGit(args, cwd, deadline, outputBudget) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error('git deadline exceeded'), { code: 'ETIMEDOUT' }));
  if (outputBudget.remaining <= 0) return Promise.reject(outputBudgetExceeded());
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: remaining,
      maxBuffer: outputBudget.remaining,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      outputBudget.remaining -= gitOutputBytes(stdout, stderr);
      if (outputBudget.remaining <= 0) {
        reject(outputBudgetExceeded());
        return;
      }
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function isNotRepository(error) {
  return error && typeof error.stderr === 'string' && /not a git repository/i.test(error.stderr);
}

// A timeout can surface either as our own proactive deadline check (ETIMEDOUT)
// or as execFile's own `timeout` option killing a running command (killed +
// SIGTERM, no reliable error code on every platform) — the latter shape is
// also what a single command exceeding execFile's own `maxBuffer` produces,
// so the output-limit codes are checked first to take precedence over it.
function classifyTransientReason(error) {
  if (!error) return null;
  if (error.code === 'EMAXBUFFER' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'git_output_limit';
  if (error.code === 'ETIMEDOUT') return 'git_timeout';
  if (error.killed === true && error.signal === 'SIGTERM') return 'git_timeout';
  return null;
}

function result(status, canonicalCwd, attemptedAt, value = null, refreshedAt = null, reason = null) {
  return { status, value, canonicalCwd, attemptedAt, refreshedAt, reason };
}

async function collectGitContext(cwd, deadlineMs = DEADLINE_MS) {
  const attemptedAt = timestamp();
  if (typeof cwd !== 'string' || cwd.length === 0) return result('transient_error', null, attemptedAt);

  let canonicalCwd;
  try {
    canonicalCwd = fs.realpathSync.native(cwd);
  } catch {
    return result('transient_error', null, attemptedAt);
  }

  const effectiveDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? deadlineMs
    : DEADLINE_MS;
  const deadline = Date.now() + effectiveDeadlineMs;
  const outputBudget = { remaining: MAX_BUFFER };
  try {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], canonicalCwd, deadline, outputBudget);
    if (inside !== 'true') return result('not_repo', canonicalCwd, attemptedAt, null, attemptedAt, 'not_repository');

    const repoRoot = await runGit(['rev-parse', '--show-toplevel'], canonicalCwd, deadline, outputBudget);
    const gitDir = await runGit(['rev-parse', '--git-dir'], canonicalCwd, deadline, outputBudget);
    const commonDir = await runGit(['rev-parse', '--git-common-dir'], canonicalCwd, deadline, outputBudget);
    const head = await runGit(['rev-parse', 'HEAD'], canonicalCwd, deadline, outputBudget);
    const dirty = (await runGit(['status', '--porcelain'], canonicalCwd, deadline, outputBudget)) !== '';
    let branch = null;
    try {
      branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], canonicalCwd, deadline, outputBudget);
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    if (branch && Buffer.byteLength(branch, 'utf8') > BRANCH_MAX_BYTES) branch = null;

    let remote = null;
    try {
      remote = sanitizeRemoteUrl(await runGit(['remote', 'get-url', 'origin'], canonicalCwd, deadline, outputBudget));
    } catch (error) {
      if (error.code !== 2 && error.code !== 128) throw error;
    }

    const resolvedGitDir = path.resolve(repoRoot, gitDir);
    const resolvedCommonDir = path.resolve(repoRoot, commonDir);
    let commonDirRealPath;
    try {
      commonDirRealPath = fs.realpathSync.native(resolvedCommonDir);
    } catch {
      commonDirRealPath = null;
    }
    const fingerprint = commonDirRealPath ? rootFingerprint(commonDirRealPath) : null;

    const value = buildPromptGitMetadata({
      observedAt: attemptedAt,
      remote,
      branch: branch || null,
      head,
      dirty,
      worktree: resolvedGitDir !== resolvedCommonDir,
      rootFingerprint: fingerprint,
    });

    return result('ok', canonicalCwd, attemptedAt, value, attemptedAt, null);
  } catch (error) {
    if (isNotRepository(error)) return result('not_repo', canonicalCwd, attemptedAt, null, attemptedAt, 'not_repository');
    return result('transient_error', canonicalCwd, attemptedAt, null, null, classifyTransientReason(error));
  }
}

module.exports = {
  DEADLINE_MS,
  MAX_BUFFER,
  collectGitContext,
  parseRemoteUrl,
  classifyTransientReason,
};
