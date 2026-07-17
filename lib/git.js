'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEADLINE_MS = 250;
const MAX_BUFFER = 64 * 1024;

function timestamp() {
  return new Date().toISOString();
}

function parseRemoteUrl(remote) {
  if (typeof remote !== 'string' || remote.trim() === '') return null;
  const value = remote.trim();
  let host;
  let pathname;

  try {
    const url = new URL(value);
    host = url.hostname || null;
    pathname = url.pathname;
  } catch {
    const match = /^(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?[:/]([^/\s]+)\/(.+)$/.exec(value);
    if (!match) return null;
    host = match[1];
    pathname = `/${match[2]}/${match[3]}`;
  }

  const parts = pathname.split('/').filter(Boolean);
  if (!host || parts.length < 2) return null;
  const repo = parts.at(-1).replace(/\.git$/, '');
  const owner = parts.at(-2);
  if (!owner || !repo) return null;
  return { host, owner, repo };
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

function result(status, canonicalCwd, attemptedAt, value = null, refreshedAt = null) {
  return { status, value, canonicalCwd, attemptedAt, refreshedAt };
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
    if (inside !== 'true') return result('not_repo', canonicalCwd, attemptedAt, null, attemptedAt);

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

    let remote = null;
    try {
      remote = parseRemoteUrl(await runGit(['remote', 'get-url', 'origin'], canonicalCwd, deadline, outputBudget));
    } catch (error) {
      if (error.code !== 2 && error.code !== 128) throw error;
    }

    const resolvedGitDir = path.resolve(repoRoot, gitDir);
    const resolvedCommonDir = path.resolve(repoRoot, commonDir);
    return result('ok', canonicalCwd, attemptedAt, {
      host: remote ? remote.host : null,
      owner: remote ? remote.owner : null,
      repo: remote ? remote.repo : null,
      branch: branch || null,
      head,
      dirty,
      worktree: resolvedGitDir !== resolvedCommonDir,
    }, attemptedAt);
  } catch (error) {
    if (isNotRepository(error)) return result('not_repo', canonicalCwd, attemptedAt, null, attemptedAt);
    return result('transient_error', canonicalCwd, attemptedAt);
  }
}

module.exports = {
  DEADLINE_MS,
  MAX_BUFFER,
  collectGitContext,
  parseRemoteUrl,
};
