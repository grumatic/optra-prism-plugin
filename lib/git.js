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
  HEAD_PATTERN,
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

// With `withStderr`, a successful call resolves to { stdout, stderr } (both
// trimmed) for a caller that must see Git's warnings; otherwise to stdout.
function runGit(args, cwd, deadline, outputBudget, { withStderr = false } = {}) {
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
      resolve(withStderr ? { stdout: stdout.trim(), stderr: (stderr || '').trim() } : stdout.trim());
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

    // Git prints both relative to the directory it ran in, which is the
    // repository root only when the cwd is; from a subdirectory the common
    // dir comes back as e.g. `../.git`.
    const resolvedGitDir = path.resolve(canonicalCwd, gitDir);
    const resolvedCommonDir = path.resolve(canonicalCwd, commonDir);
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

const ROOT_BASELINE_DEADLINE_MS = 1000;

/**
 * The real path of the worktree root (`--show-toplevel`) that contains `cwd`,
 * or null when it is not inside a work tree or Git cannot answer in time.
 * Turn baselines are keyed by this root, so a `cd` into a subdirectory of
 * the same worktree never looks like a move to another repository.
 */
// `deadlineAt` (an absolute epoch-ms deadline) lets one hook share a single
// budget across this and resolveHeadAt; deadlineMs applies only without it.
async function resolveWorktreeRoot(cwd, deadlineMs = ROOT_BASELINE_DEADLINE_MS, { deadlineAt } = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  try {
    const canonicalCwd = fs.realpathSync.native(cwd);
    const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + deadlineMs;
    const toplevel = await runGit(['rev-parse', '--show-toplevel'], canonicalCwd, deadline, { remaining: MAX_BUFFER });
    return toplevel ? fs.realpathSync.native(toplevel) : null;
  } catch {
    return null;
  }
}

const REFLOG_FIRST_LINE_BYTES = 4096;
// `<old> <new> <name> <<email>> <time> <zone>[\t<message>]`. Git strips `<`
// and `>` from names and emails, so the first `>` ends the identity and a
// name holding a tab or a time-like text cannot pass for the time.
const REFLOG_LINE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^>\n]*> (\d+) [+-]\d{4}(?:\t(.*))?$/;
// Printed when the walk back through the log meets an entry that starts
// from nothing (an orphan branch's first commit) or does not continue from
// the one before it. The answer is then not the head at that time: Git
// leaves the current head in place.
const REFLOG_BROKEN_WARNING = /unexpectedly ended|has gap/;

/**
 * Whether the reflog's own answer for `head` at `lookupSeconds` can be
 * trusted although `head` was committed after that time, decided from the
 * oldest entry of `root`'s own HEAD log:
 *   - an entry no newer than the lookup means the log covers that time, so
 *     its answer stands (a commit dated ahead of this machine's clock);
 *   - a newer one stands only when it created the worktree on `head`: it
 *     starts from nothing (a zero old value), lands on `head`, and is not a
 *     first commit (`commit (initial)`), whose answer is the commit to
 *     report rather than the baseline.
 * A non-zero old value (a reflog expired since), an unreadable entry and a
 * missing own HEAD log (Git answered from the branch's log) all say no.
 */
async function reflogAnswerStands(root, head, lookupSeconds, deadline, budget) {
  let first;
  try {
    const logPath = path.resolve(root, await runGit(['rev-parse', '--git-path', 'logs/HEAD'], root, deadline, budget));
    const buffer = Buffer.alloc(REFLOG_FIRST_LINE_BYTES);
    const fd = fs.openSync(logPath, 'r');
    let bytes;
    try { bytes = fs.readSync(fd, buffer, 0, buffer.length, 0); } finally { fs.closeSync(fd); }
    first = buffer.subarray(0, bytes).toString('utf8').split('\n')[0];
  } catch {
    return false;
  }
  const entry = first.match(REFLOG_LINE);
  if (!entry) return false;
  if (Number(entry[3]) <= lookupSeconds) return true;
  return /^0+$/.test(entry[1])
    && entry[2] === head
    && !(entry[4] || '').startsWith('commit (initial)');
}

/**
 * The commit `root` currently has checked out, or null when it has none, is
 * not a work tree any more, or Git cannot answer in time.
 */
async function readHead(root, { deadlineMs = ROOT_BASELINE_DEADLINE_MS, deadlineAt } = {}) {
  if (typeof root !== 'string' || root.length === 0) return null;
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + deadlineMs;
  try {
    const head = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], root, deadline, { remaining: MAX_BUFFER });
    return HEAD_PATTERN.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * The head `root` had at `at`, read from that worktree's own HEAD reflog.
 * For a reflog that starts after `at`, Git answers with the value before its
 * oldest entry, or, when that entry created the ref (a worktree created
 * later), the commit the worktree was created from. Without
 * any reflog answer the result is the current head only when
 * `fallbackToCurrent` is set; otherwise null, so a caller that must not
 * substitute a later head fails closed.
 *
 * When Git warns that the log is broken before that time (an orphan branch
 * committed later, or a gap), its answer is the current head rather than the
 * head at `at`, so it is refused, with no fallback either.
 *
 * Reflog times are whole seconds and Git drops the milliseconds of `at`, so
 * an update later in the same second as `at` would count as before it. The
 * lookup is made one second earlier instead: a commit from that second is
 * then reported (possibly twice, which the service de-duplicates by SHA)
 * rather than lost.
 *
 * An answer committed after the lookup time is checked against the reflog
 * itself (see reflogAnswerStands). It stands when the log covers that time
 * (a commit dated ahead of the local clock) or when the worktree was created
 * later from it (a worktree added during the turn from a commit made during
 * it). Otherwise Git gives one when HEAD itself was born later (a repository
 * or orphan branch whose first commit this is) or when the reflog was
 * expired since, and its answer is then the first commit to report, not the
 * baseline. Such an answer is refused outright, with no fallback, since the
 * reflog did answer. Only that rarer answer costs the extra read.
 *
 * The current-head fallback takes only a head committed no later than the
 * lookup: a later one may be a commit the turn made before the caller saw
 * the root (`git commit` and `cd` in one command), so it is refused too.
 *
 * `rev-list`, not `log`: `log.showSignature` (and other `log.*` settings)
 * would print a signature check before the formatted line.
 */
async function resolveHeadAt(root, at, { fallbackToCurrent = false, deadlineMs = ROOT_BASELINE_DEADLINE_MS, deadlineAt } = {}) {
  const atMs = Date.parse(at);
  if (typeof root !== 'string' || root.length === 0 || !Number.isFinite(atMs)) return null;
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + deadlineMs;
  const budget = { remaining: MAX_BUFFER };
  const observedAt = timestamp();
  const lookupSeconds = Math.floor(atMs / 1000) - 1;
  const lookupAt = new Date(lookupSeconds * 1000).toISOString();
  const parse = (line) => {
    const [committedAt, head] = (line || '').split(' ');
    return HEAD_PATTERN.test(head || '') && /^\d+$/.test(committedAt || '')
      ? { head, committedAt: Number(committedAt) }
      : null;
  };
  let answer = null;
  try {
    answer = await runGit(
      ['rev-list', '-1', '--timestamp', `HEAD@{${lookupAt}}`, '--'], root, deadline, budget, { withStderr: true },
    );
  } catch {}
  if (answer && answer.stdout) {
    const found = parse(answer.stdout);
    if (!found || REFLOG_BROKEN_WARNING.test(answer.stderr)) return null;
    if (found.committedAt <= lookupSeconds
      || await reflogAnswerStands(root, found.head, lookupSeconds, deadline, budget)) {
      return { head: found.head, observedAt, fromReflog: true };
    }
    return null;
  }
  if (!fallbackToCurrent) return null;
  try {
    const current = parse(await runGit(['rev-list', '-1', '--timestamp', 'HEAD', '--'], root, deadline, budget));
    return current && current.committedAt <= lookupSeconds ? { head: current.head, observedAt, fromReflog: false } : null;
  } catch {
    return null;
  }
}

/** Final Stop-time snapshot: head, dirty, branch, remote identity, root fingerprint. */
// `deadlineAt` (an absolute epoch-ms deadline) lets a caller share one
// budget across both collectFinalGitState and collectCommittedRange for a
// single Stop capture; deadlineMs alone is used only when no shared deadline
// was threaded through.
// `skipDirty` leaves `dirty` null without running `git status`, the slowest
// call in a large worktree, for a caller whose event omits it.
async function collectFinalGitState(cwd, deadlineMs = EVIDENCE_COLLECT_DEADLINE_MS, { deadlineAt, skipDirty = false } = {}) {
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

    const commonDir = await runGit(['rev-parse', '--git-common-dir'], canonicalCwd, deadline, outputBudget);
    const head = await runGit(['rev-parse', 'HEAD'], canonicalCwd, deadline, outputBudget);
    const dirty = skipDirty
      ? null
      : (await runGit(['status', '--porcelain'], canonicalCwd, deadline, outputBudget)) !== '';
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

    // Relative to the directory Git ran in, as in collectGitContext.
    const resolvedCommonDir = path.resolve(canonicalCwd, commonDir);
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

// `Name <email> <epoch> <tz>`, as `git var GIT_AUTHOR_IDENT` prints it.
const AUTHOR_IDENT_PATTERN = /<([^<>]*)>\s+\d+\s+[+-]\d{4}$/;
// The author lookup's own slice of the shared deadline. With no email
// configured, Git may resolve the host name to guess one, and a slow
// resolver must cost only the verdict, never the committed range itself.
const AUTHOR_LOOKUP_DEADLINE_MS = 1000;
// Prefixes each author-email line of `rev-list --format`, so an empty email
// still prints a line and no email can pass for a `commit <sha>` header.
const AUTHOR_EMAIL_LINE_PREFIX = '\x01';

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The normalized author email Git itself would record for a new commit here,
 * or null when Git cannot determine one. `git var GIT_AUTHOR_IDENT` applies
 * Git's own precedence (GIT_AUTHOR_EMAIL, author.email, user.email, EMAIL)
 * and cleanup, in the repository's cwd (so an `includeIf` section applies)
 * and in the environment this hook shares with the session's Git commands.
 * The value never leaves this module: it is only compared against each
 * commit's author email.
 */
async function resolveAuthorEmail(cwd, deadline, outputBudget) {
  let ident;
  try {
    ident = await runGit(
      ['var', 'GIT_AUTHOR_IDENT'],
      cwd,
      Math.min(deadline, Date.now() + AUTHOR_LOOKUP_DEADLINE_MS),
      outputBudget,
    );
  } catch {
    // Git refuses (no usable identity, user.useConfigOnly) or the call
    // failed: no verdict is made rather than a guess.
    return null;
  }
  const match = AUTHOR_IDENT_PATTERN.exec(ident);
  return (match && normalizeEmail(match[1])) || null;
}

/**
 * baseline -> final first-parent committed range.
 * Never returns a raw diff, path, commit message, or author. With
 * `judgeAuthors` (git-evidence/v2 only), each commit additionally carries
 * `authorFilter` ('own' | 'foreign') and the range a `foreignCommitFilter`
 * ('applied' | 'unavailable'); without it the Git calls are exactly v1's.
 */
async function collectCommittedRange({
  cwd,
  baselineHead,
  finalHead,
  deadlineMs = EVIDENCE_COLLECT_DEADLINE_MS,
  deadlineAt,
  outputBudgetBytes = EVIDENCE_OUTPUT_BUDGET_BYTES,
  commitLimit = MAX_GIT_EVIDENCE_COMMITS,
  judgeAuthors = false,
}) {
  const effectiveDeadlineMs = Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : EVIDENCE_COLLECT_DEADLINE_MS;
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + effectiveDeadlineMs;
  const outputBudget = {
    remaining: Number.isFinite(outputBudgetBytes) && outputBudgetBytes > 0 ? outputBudgetBytes : EVIDENCE_OUTPUT_BUDGET_BYTES,
  };
  const withFilter = (range, authorEmail) => (judgeAuthors
    ? { ...range, foreignCommitFilter: authorEmail ? 'applied' : 'unavailable' }
    : range);

  try {
    const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, deadline, outputBudget);
    if (inside !== 'true') return withFilter(unavailableRange('unknown', 'final_snapshot_failed'), null);
  } catch {
    return withFilter(unavailableRange('unknown', 'final_snapshot_failed'), null);
  }

  const authorEmail = judgeAuthors ? await resolveAuthorEmail(cwd, deadline, outputBudget) : null;
  const range = await walkCommittedRange({
    cwd, baselineHead, finalHead, deadline, outputBudget, commitLimit, authorEmail,
  });
  return withFilter(range, authorEmail);
}

async function walkCommittedRange({
  cwd, baselineHead, finalHead, deadline, outputBudget, commitLimit, authorEmail,
}) {
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
  // The remaining fields are the merge parents, so the count of all of them
  // is the commit's parent count.
  //
  // With an author email to compare against, `--format` adds one prefixed
  // author-email line after each `commit <sha> <parent>...` header.
  let shas;
  let parentOf;
  let parentCountOf;
  let authorEmailOf;
  try {
    const stdout = await runGit(
      [
        'rev-list', '--first-parent', '--parents', '--reverse',
        ...(authorEmail ? ['--format=%x01%ae'] : []),
        `${baselineHead}..${finalHead}`,
      ],
      cwd,
      deadline,
      outputBudget,
    );
    const lines = stdout === '' ? [] : stdout.split('\n');
    shas = [];
    parentOf = new Map();
    parentCountOf = new Map();
    authorEmailOf = new Map();
    for (const line of lines) {
      if (authorEmail && line.startsWith(AUTHOR_EMAIL_LINE_PREFIX)) {
        if (shas.length === 0) throw new Error('author email before any commit');
        authorEmailOf.set(shas[shas.length - 1], line.slice(AUTHOR_EMAIL_LINE_PREFIX.length));
        continue;
      }
      const fields = line.split(' ').filter(Boolean);
      if (authorEmail && fields.shift() !== 'commit') throw new Error('unexpected rev-list header');
      const commitSha = fields[0];
      shas.push(commitSha);
      parentOf.set(commitSha, fields.length > 1 ? fields[1] : undefined);
      parentCountOf.set(commitSha, fields.length > 1 ? fields.length - 1 : undefined);
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
      parentCount: parentCountOf.get(commitSha),
      addedLines,
      deletedLines,
      // An observer-independent identity: the author verdict is never an input.
      fingerprint: commitFingerprint({
        commitSha, parentSha, addedLines, deletedLines,
      }),
      ...(authorEmail
        ? { authorFilter: normalizeEmail(authorEmailOf.get(commitSha)) === authorEmail ? 'own' : 'foreign' }
        : {}),
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
  ROOT_BASELINE_DEADLINE_MS,
  collectGitContext,
  resolveWorktreeRoot,
  resolveHeadAt,
  readHead,
  collectFinalGitState,
  collectCommittedRange,
  parseRemoteUrl,
  classifyTransientReason,
};
