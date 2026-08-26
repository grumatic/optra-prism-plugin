'use strict';

/**
 * Shared vocabulary for `prompt-git-metadata/v1` and its future committed-
 * evidence sibling: the wire shape, sanitization rules, and the install-local
 * HMAC key that roots the repository fingerprint. No network work happens
 * here, and no exported function throws.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROMPT_GIT_METADATA_SCHEMA_VERSION = 'prompt-git-metadata/v1';
const PROMPT_GIT_COVERAGE_READY = 'ready';
const PROMPT_GIT_COVERAGE_UNAVAILABLE = 'unavailable';

// Closed V1 enum. Order is the precedence order used by buildPromptGitMetadata.
const PROMPT_GIT_REASONS = Object.freeze([
  'not_repository',
  'git_timeout',
  'git_output_limit',
  'root_key_unavailable',
  'remote_missing',
]);

// Reasons that describe a failed collection attempt rather than an incomplete
// identity; these travel on the session git record envelope, not inside the
// wire value.
const PROMPT_GIT_ENVELOPE_REASONS = Object.freeze([
  'not_repository', 'git_timeout', 'git_output_limit',
]);

const ROOT_FINGERPRINT_DOMAIN = 'prism-git-root/v1\0';
const INSTALL_KEY_BYTES = 32;
const HOST_MAX_BYTES = 255;
const REPO_MAX_BYTES = 255;
const OWNER_PATH_MAX_BYTES = 512;
const BRANCH_MAX_BYTES = 1024;

// Keyed by installKeyPath() rather than a single process-wide slot, so a
// caller that changes CLAUDE_PLUGIN_DATA mid-process (tests; a long-lived
// host process) gets its own cache entry instead of a stale one.
const installKeyCache = new Map();

/** Absolute path of the install-local key file. */
function installKeyPath() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'plugins', 'data', 'prism-optra-prism');
  return path.join(dataDir, 'runtime', 'git-evidence-install-key-v1');
}

/** Existing key bytes, `undefined` when absent, or `null` on any read failure. */
function readInstallKeyFile(finalPath) {
  try {
    return fs.readFileSync(finalPath);
  } catch (error) {
    return error && error.code === 'ENOENT' ? undefined : null;
  }
}

function publishInstallKey(dir, finalPath) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  const key = crypto.randomBytes(INSTALL_KEY_BYTES);
  const temp = path.join(dir, `.git-evidence-install-key-v1.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, key, { mode: 0o600, flag: 'wx' });
    try {
      // linkSync, not rename: a concurrent publish loses this race instead
      // of silently overwriting a key that is already in use.
      fs.linkSync(temp, finalPath);
      return key;
    } catch (linkError) {
      if (linkError && linkError.code === 'EEXIST') {
        const existing = readInstallKeyFile(finalPath);
        return existing && existing.length === INSTALL_KEY_BYTES ? existing : null;
      }
      return null;
    }
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

/** 32-byte key, or null when missing-and-uncreatable, corrupt, or unreadable. Memoized per installKeyPath(). */
function loadInstallKey() {
  const finalPath = installKeyPath();
  if (installKeyCache.has(finalPath)) return installKeyCache.get(finalPath);

  const existing = readInstallKeyFile(finalPath);
  let key;
  if (existing === null) {
    // Present but unreadable, or some other non-ENOENT read failure: leave
    // the file untouched and degrade for this process.
    key = null;
  } else if (existing === undefined) {
    key = publishInstallKey(path.dirname(finalPath), finalPath);
  } else {
    key = existing.length === INSTALL_KEY_BYTES ? existing : null;
  }
  installKeyCache.set(finalPath, key);
  return key;
}

/** Lower-case hex HMAC-SHA256 over the Git common dir, or null when the key is unavailable. */
function rootFingerprint(gitCommonDirRealPath) {
  const key = loadInstallKey();
  if (!key || typeof gitCommonDirRealPath !== 'string' || gitCommonDirRealPath.length === 0) return null;
  const input = Buffer.concat([
    Buffer.from(ROOT_FINGERPRINT_DOMAIN, 'utf8'),
    Buffer.from(gitCommonDirRealPath, 'utf8'),
  ]);
  return crypto.createHmac('sha256', key).update(input).digest('hex');
}

function normalizeHost(rawHost) {
  if (typeof rawHost !== 'string' || rawHost.length === 0) return null;
  return rawHost.replace(/^\[|\]$/g, '').toLowerCase();
}

function pathSegments(pathname) {
  return typeof pathname === 'string' ? pathname.split('/').filter(Boolean) : [];
}

/** { host, ownerPath, owner, repo } with userinfo/port/query/fragment stripped, or null. */
function sanitizeRemoteUrl(remote) {
  if (typeof remote !== 'string' || remote.trim() === '') return null;
  const value = remote.trim();
  // A relative or absolute local filesystem path is never a remote identity,
  // and must be rejected before it can be misread as scp-like host syntax.
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return null;

  let host = null;
  let segments = [];
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') return null;
    host = normalizeHost(url.hostname);
    segments = pathSegments(url.pathname);
  } catch {
    // scp-like syntax has no scheme and no port: [user@]host:path. A bare
    // "a/b/c" with no "@" and no ":" is a relative path, not a remote, and
    // must not match here.
    const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
    if (!match) return null;
    host = normalizeHost(match[1]);
    segments = pathSegments(match[2]);
  }

  if (!host || host === '.' || host === '..' || segments.length < 2) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;

  const repo = segments[segments.length - 1].replace(/\.git$/, '');
  const ownerSegments = segments.slice(0, -1);
  const ownerPath = ownerSegments.join('/');
  const owner = ownerSegments[ownerSegments.length - 1];
  if (!repo || !owner) return null;

  if (
    Buffer.byteLength(host, 'utf8') > HOST_MAX_BYTES
    || Buffer.byteLength(ownerPath, 'utf8') > OWNER_PATH_MAX_BYTES
    || Buffer.byteLength(repo, 'utf8') > REPO_MAX_BYTES
  ) return null;

  return { host, ownerPath, owner, repo };
}

/** Back-compat shape for callers that only need { host, owner, repo }. */
function parseRemoteUrl(remote) {
  const sanitized = sanitizeRemoteUrl(remote);
  return sanitized ? { host: sanitized.host, owner: sanitized.owner, repo: sanitized.repo } : null;
}

/**
 * The wire object. `remote` is a sanitizeRemoteUrl result or null.
 * Returns the fixed-key-order plain object for the `metadata.git` member.
 */
function buildPromptGitMetadata({
  observedAt, remote, branch, head, dirty, worktree, rootFingerprint: fingerprint,
}) {
  let coverage = PROMPT_GIT_COVERAGE_READY;
  let reason = null;
  if (fingerprint == null) {
    coverage = PROMPT_GIT_COVERAGE_UNAVAILABLE;
    reason = 'root_key_unavailable';
  } else if (remote == null) {
    coverage = PROMPT_GIT_COVERAGE_UNAVAILABLE;
    reason = 'remote_missing';
  }

  return {
    schema_version: PROMPT_GIT_METADATA_SCHEMA_VERSION,
    observed_at: observedAt,
    host: remote == null ? null : remote.host,
    owner: remote == null ? null : remote.owner,
    ...(remote != null && remote.ownerPath ? { owner_path: remote.ownerPath } : {}),
    repo: remote == null ? null : remote.repo,
    branch: branch || null,
    head,
    dirty,
    worktree,
    ...(fingerprint != null ? { root_fingerprint: fingerprint } : {}),
    coverage,
    ...(reason != null ? { reason } : {}),
  };
}

/** { schema_version, observed_at, coverage: 'unavailable', reason }. */
function unavailablePromptGitMetadata(reason, observedAt) {
  return {
    schema_version: PROMPT_GIT_METADATA_SCHEMA_VERSION,
    observed_at: observedAt,
    coverage: PROMPT_GIT_COVERAGE_UNAVAILABLE,
    reason,
  };
}

module.exports = {
  PROMPT_GIT_METADATA_SCHEMA_VERSION,
  PROMPT_GIT_COVERAGE_READY,
  PROMPT_GIT_COVERAGE_UNAVAILABLE,
  PROMPT_GIT_REASONS,
  PROMPT_GIT_ENVELOPE_REASONS,
  HOST_MAX_BYTES,
  REPO_MAX_BYTES,
  OWNER_PATH_MAX_BYTES,
  BRANCH_MAX_BYTES,
  installKeyPath,
  loadInstallKey,
  rootFingerprint,
  sanitizeRemoteUrl,
  parseRemoteUrl,
  buildPromptGitMetadata,
  unavailablePromptGitMetadata,
};
