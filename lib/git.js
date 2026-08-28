'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  sanitizeRemoteUrl,
  parseRemoteUrl,
  buildPromptGitMetadata,
  rootFingerprint,
  commitFingerprint,
  BRANCH_MAX_BYTES,
  MAX_GIT_EVIDENCE_COMMITS,
} = require('./git-evidence-contract');

const DEADLINE_MS = 250;
const MAX_BUFFER = 64 * 1024;
const EVIDENCE_COLLECT_DEADLINE_MS = 5000;
const EVIDENCE_OUTPUT_BUDGET_BYTES = 4 * 1024 * 1024;
const EVIDENCE_RESUME_MAX_AGE_MS = 300000;
// The empty-tree object every Git repository has, used as the diff base for
// a root commit with no parent — see the parentOf(root) === undefined case.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// Deterministic, script-friendly Git behavior for a hook process: no index
// lock contention with an interactive `git status`, never blocks on a
// credential prompt, and stable (non-localized) porcelain output. Computed
// fresh per call (not a module-load-time snapshot): a snapshot would freeze
// the executable search path (and anything else a caller — including a
// test — sets after this module first loads) at whatever it was when
// lib/git.js was first required.
function gitEnv() {
  return {
    ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
  };
}

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
      env: gitEnv(),
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

/** Final Stop-time snapshot: head, dirty, branch, remote identity, root fingerprint. */
// `deadlineAt` (an absolute epoch-ms deadline) lets a caller share one
// budget across both collectFinalGitState and collectCommittedRange for a
// single Stop capture; deadlineMs alone is used only when no shared deadline
// was threaded through.
async function collectFinalGitState(cwd, deadlineMs = EVIDENCE_COLLECT_DEADLINE_MS, { deadlineAt } = {}) {
  const attemptedAt = timestamp();
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { status: 'transient_error', canonicalCwd: null, head: null, dirty: null, branch: null, remote: null, rootFingerprint: null, reason: null };
  }

  let canonicalCwd;
  try {
    canonicalCwd = fs.realpathSync.native(cwd);
  } catch {
    return { status: 'transient_error', canonicalCwd: null, head: null, dirty: null, branch: null, remote: null, rootFingerprint: null, reason: null };
  }

  const effectiveDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : EVIDENCE_COLLECT_DEADLINE_MS;
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + effectiveDeadlineMs;
  const outputBudget = { remaining: EVIDENCE_OUTPUT_BUDGET_BYTES };
  const base = {
    canonicalCwd, head: null, dirty: null, branch: null, remote: null, rootFingerprint: null, reason: null,
  };
  try {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], canonicalCwd, deadline, outputBudget);
    if (inside !== 'true') return { ...base, status: 'not_repo', reason: 'not_repository' };

    const repoRoot = await runGit(['rev-parse', '--show-toplevel'], canonicalCwd, deadline, outputBudget);
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

    const resolvedCommonDir = path.resolve(repoRoot, commonDir);
    let commonDirRealPath;
    try {
      commonDirRealPath = fs.realpathSync.native(resolvedCommonDir);
    } catch {
      commonDirRealPath = null;
    }
    const fingerprint = commonDirRealPath ? rootFingerprint(commonDirRealPath) : null;

    return {
      ...base, status: 'ok', head, dirty, branch: branch || null, remote, rootFingerprint: fingerprint,
    };
  } catch (error) {
    if (isNotRepository(error)) return { ...base, status: 'not_repo', reason: 'not_repository' };
    return { ...base, status: 'transient_error', reason: classifyTransientReason(error) };
  }
}

/** NUL-safe reader for `git diff --numstat -z`: one { added, deleted, binary } record per call. */
function parseNumstatRecord(buffer, offset) {
  const firstTab = buffer.indexOf(0x09, offset);
  if (firstTab === -1) return null;
  const secondTab = buffer.indexOf(0x09, firstTab + 1);
  if (secondTab === -1) return null;
  const pathEnd = buffer.indexOf(0x00, secondTab + 1);
  if (pathEnd === -1) return null;
  const added = buffer.toString('utf8', offset, firstTab);
  const deleted = buffer.toString('utf8', firstTab + 1, secondTab);
  return { added, deleted, nextOffset: pathEnd + 1 };
}

function parseNumstatOutput(text) {
  const buffer = Buffer.from(text, 'utf8');
  const records = [];
  let offset = 0;
  while (offset < buffer.length) {
    const record = parseNumstatRecord(buffer, offset);
    if (!record) break;
    records.push(record);
    offset = record.nextOffset;
  }
  return records;
}

/** Count `--raw -z` entries whose source or destination mode is a gitlink (160000). */
function countSubmoduleEntries(text) {
  const fields = text.split('\0').filter(Boolean);
  let count = 0;
  let i = 0;
  while (i < fields.length) {
    const header = fields[i];
    if (!header.startsWith(':')) { i += 1; continue; }
    const modes = header.slice(1).split(' ').filter(Boolean);
    if (modes[0] === '160000' || modes[1] === '160000') count += 1;
    // header, path[, path2 for renames — --no-renames means never reached]
    i += 2;
  }
  return count;
}

function unavailableRange(ancestry, reason) {
  return {
    ancestry, coverage: 'unavailable', reason, excludedBinaryCount: 0, excludedSubmoduleCount: 0, commits: [],
  };
}

/**
 * baseline -> final first-parent committed range.
 * Never returns a raw diff, path, commit message, or author.
 */
async function collectCommittedRange({
  cwd,
  baselineHead,
  finalHead,
  deadlineMs = EVIDENCE_COLLECT_DEADLINE_MS,
  deadlineAt,
  outputBudgetBytes = EVIDENCE_OUTPUT_BUDGET_BYTES,
  commitLimit = MAX_GIT_EVIDENCE_COMMITS,
}) {
  const effectiveDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : EVIDENCE_COLLECT_DEADLINE_MS;
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + effectiveDeadlineMs;
  const outputBudget = {
    remaining: Number.isFinite(outputBudgetBytes) && outputBudgetBytes > 0 ? outputBudgetBytes : EVIDENCE_OUTPUT_BUDGET_BYTES,
  };

  try {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, deadline, outputBudget);
    if (inside !== 'true') return unavailableRange('unknown', 'final_snapshot_failed');
  } catch {
    return unavailableRange('unknown', 'final_snapshot_failed');
  }

  if (baselineHead === finalHead) {
    return {
      ancestry: 'linear', coverage: 'ready', reason: null, excludedBinaryCount: 0, excludedSubmoduleCount: 0, commits: [],
    };
  }

  let ancestry;
  try {
    await runGit(['merge-base', '--is-ancestor', baselineHead, finalHead], cwd, deadline, outputBudget);
    ancestry = 'linear';
  } catch (error) {
    if (Number.isInteger(error.code) && error.code === 1) {
      return {
        ancestry: 'non_ancestor', coverage: 'partial', reason: 'non_ancestor', excludedBinaryCount: 0, excludedSubmoduleCount: 0, commits: [],
      };
    }
    return unavailableRange('unknown', 'final_snapshot_failed');
  }

  // `--parents` carries each commit's real parent SHAs; the first-parent
  // walk already restricts which commits are visited, but the parent of a
  // merge commit reached this way is that commit's OWN first parent (which
  // may be unrelated to the previous line in this output), never the
  // previous listed commit. fields[1] is that first parent; a root commit
  // (no parent at all — only possible in a degenerate repository) has none.
  let shas;
  let parentOf;
  try {
    const stdout = await runGit(
      ['rev-list', '--first-parent', '--parents', '--reverse', `${baselineHead}..${finalHead}`],
      cwd,
      deadline,
      outputBudget,
    );
    const lines = stdout === '' ? [] : stdout.split('\n');
    shas = [];
    parentOf = new Map();
    for (const line of lines) {
      const fields = line.split(' ').filter(Boolean);
      const commitSha = fields[0];
      shas.push(commitSha);
      parentOf.set(commitSha, fields.length > 1 ? fields[1] : undefined);
    }
  } catch {
    return unavailableRange(ancestry, 'final_snapshot_failed');
  }

  if (shas.length > commitLimit) {
    return { ancestry, coverage: 'unavailable', reason: 'commit_limit_exceeded', excludedBinaryCount: 0, excludedSubmoduleCount: 0, commits: [] };
  }

  let excludedBinaryCount = 0;
  let binaryOrSubmoduleUnresolved = false;
  const commits = [];
  let deadlineOrBudgetExhausted = false;

  for (let i = 0; i < shas.length; i += 1) {
    const commitSha = shas[i];
    const parentSha = parentOf.get(commitSha);
    let numstatOutput;
    try {
      numstatOutput = await runGit(
        ['diff', '--numstat', '-z', '--no-renames', '--ignore-submodules=all', parentSha || EMPTY_TREE_SHA, commitSha],
        cwd,
        deadline,
        outputBudget,
      );
    } catch (error) {
      if (classifyTransientReason(error) !== null) {
        deadlineOrBudgetExhausted = true;
        break;
      }
      binaryOrSubmoduleUnresolved = true;
      continue;
    }

    let addedLines = 0;
    let deletedLines = 0;
    for (const record of parseNumstatOutput(numstatOutput)) {
      if (record.added === '-' && record.deleted === '-') {
        excludedBinaryCount += 1;
        continue;
      }
      const added = Number(record.added);
      const deleted = Number(record.deleted);
      if (!Number.isSafeInteger(added) || added < 0 || !Number.isSafeInteger(deleted) || deleted < 0) {
        binaryOrSubmoduleUnresolved = true;
        continue;
      }
      addedLines += added;
      deletedLines += deleted;
    }

    commits.push({
      commitSha,
      parentSha,
      addedLines,
      deletedLines,
      fingerprint: commitFingerprint({
        commitSha, parentSha, addedLines, deletedLines,
      }),
    });
  }

  // A failure of this single whole-range call — including a deadline or
  // output-budget hit — must never discard the commits already parsed above:
  // it downgrades coverage to `partial`, exactly like any other unresolved
  // submodule/binary record, rather than reusing deadlineOrBudgetExhausted's
  // discard-everything path (see the plan's per-call failure isolation).
  let excludedSubmoduleCount = 0;
  if (!deadlineOrBudgetExhausted && shas.length > 0) {
    try {
      const rawOutput = await runGit(
        ['diff', '--raw', '-z', '--no-renames', baselineHead, finalHead],
        cwd,
        deadline,
        outputBudget,
      );
      excludedSubmoduleCount = countSubmoduleEntries(rawOutput);
    } catch {
      binaryOrSubmoduleUnresolved = true;
      excludedSubmoduleCount = 0;
    }
  }

  if (deadlineOrBudgetExhausted) {
    return { ancestry, coverage: 'unavailable', reason: 'final_snapshot_failed', excludedBinaryCount: 0, excludedSubmoduleCount: 0, commits: [] };
  }
  if (binaryOrSubmoduleUnresolved) {
    return {
      ancestry, coverage: 'partial', reason: 'binary_or_submodule_unresolved', excludedBinaryCount, excludedSubmoduleCount, commits,
    };
  }
  return {
    ancestry, coverage: 'ready', reason: null, excludedBinaryCount, excludedSubmoduleCount, commits,
  };
}

module.exports = {
  DEADLINE_MS,
  MAX_BUFFER,
  EVIDENCE_COLLECT_DEADLINE_MS,
  EVIDENCE_OUTPUT_BUDGET_BYTES,
  EVIDENCE_RESUME_MAX_AGE_MS,
  collectGitContext,
  collectFinalGitState,
  collectCommittedRange,
  parseRemoteUrl,
  classifyTransientReason,
};
