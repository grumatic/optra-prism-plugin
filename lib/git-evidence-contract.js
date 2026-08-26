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

// ─── git-evidence/v1 ───
//
// Wire vocabulary for the committed-evidence sibling of prompt-git-metadata/v1.
// The Plugin only ever produces `committed_change_observation` events; the
// `git_snapshot` and `verification` variants exist solely as compatibility
// members of the closed enum the server also accepts.

const GIT_EVIDENCE_SCHEMA_VERSION = 'git-evidence/v1';
const GIT_EVIDENCE_ENDPOINT_PATH = '/v1/git-evidence';
const GIT_EVIDENCE_DIFF_POLICY_VERSION = 'git_text_numstat_first_parent_v1';
const GIT_EVIDENCE_MERGE_POLICY = 'first_parent_v1';
const MAX_GIT_EVIDENCE_REQUEST_BYTES = 524288;
const MAX_GIT_EVIDENCE_COMMITS = 512;
const MAX_GIT_EVIDENCE_RESPONSE_BYTES = 4096;
const MAX_GIT_EVIDENCE_SESSION_ID_BYTES = 1024;
const MAX_GIT_EVIDENCE_HOST_PROMPT_ID_BYTES = 1024;
const MAX_GIT_EVIDENCE_HOST_BYTES = 255;
const MAX_GIT_EVIDENCE_OWNER_PATH_BYTES = 512;
const MAX_GIT_EVIDENCE_REPOSITORY_BYTES = 255;
const MAX_GIT_EVIDENCE_BRANCH_BYTES = BRANCH_MAX_BYTES;
const COMMIT_FINGERPRINT_DOMAIN = 'prism-git-commit/v1\0';
const EVENT_ID_DOMAIN = 'prism-git-evidence-event/v1\0';

const GIT_EVIDENCE_EVENT_TYPES = Object.freeze([
  'git_snapshot', 'committed_change_observation', 'verification',
]);
const GIT_EVIDENCE_PHASES = Object.freeze(['prompt', 'stop']);
const GIT_EVIDENCE_ANCESTRY = Object.freeze(['linear', 'non_ancestor', 'unknown']);
const GIT_EVIDENCE_DIFF_COVERAGE = Object.freeze(['ready', 'partial', 'unavailable']);
const GIT_EVIDENCE_DIFF_REASONS = Object.freeze([
  'baseline_missing', 'final_snapshot_failed', 'non_ancestor',
  'commit_limit_exceeded', 'payload_budget_exceeded',
  'binary_or_submodule_unresolved',
]);
const GIT_EVIDENCE_LOCAL_TERMINAL_REASONS = Object.freeze([
  'local_capacity_full', 'local_entry_oversized',
  'local_retention_expired', 'permanent_http_rejection', 'event_conflict',
]);
const GIT_EVIDENCE_ERROR_CODES = Object.freeze([
  'git_evidence_invalid_payload', 'git_evidence_disallowed_field',
  'git_evidence_commit_limit_exceeded', 'git_evidence_unsupported_schema',
  'git_evidence_event_conflict', 'git_evidence_unsupported_media_type',
]);
const GIT_EVIDENCE_BODY_TOO_LARGE_TEXT = 'Request body too large';

// Member names that must never appear anywhere in a V1 body, at any depth.
// Mirrors the server's DISALLOWED_FIELD_NAMES exactly; this is the client
// self-check that makes plugin_contract_v1 sanitization provable locally.
const GIT_EVIDENCE_DISALLOWED_FIELD_NAMES = Object.freeze([
  'remote_url', 'url', 'remote', 'clone_url', 'ssh_url', 'html_url', 'origin_url',
  'credential', 'credentials', 'token', 'access_token', 'password', 'secret', 'auth', 'authorization',
  'cwd', 'path', 'paths', 'file_path', 'file_paths', 'absolute_path', 'changed_paths', 'changed_files',
  'files', 'working_directory', 'repo_path', 'root_path', 'worktree_path',
  'diff_text', 'patch', 'content', 'source', 'source_content', 'blob', 'body',
  'commit_message', 'message', 'subject', 'author', 'author_name', 'author_email',
  'committer', 'committer_name', 'committer_email', 'email',
  'working_tree_snapshot', 'uncommitted', 'staged', 'unstaged', 'untracked',
]);
const GIT_EVIDENCE_DISALLOWED_VALUE = 'working_tree_snapshot';
const GIT_EVIDENCE_ENUM_BEARING_MEMBER_NAMES = Object.freeze([
  'event_type', 'phase', 'ancestry', 'coverage', 'reason', 'kind', 'status', 'merge_policy',
]);

/** RFC 8785-shaped canonical JSON: recursively sorted member names, no whitespace. */
function canonicalJson(value) {
  return JSON.stringify(canonicalizeForJson(value));
}

function canonicalizeForJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForJson);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalizeForJson(value[key]);
    return sorted;
  }
  return value;
}

/** Deterministic non-nil UUID for one Stop capture. */
function deriveEvidenceEventId(responseOperationId) {
  const digest = crypto.createHash('sha256')
    .update(EVENT_ID_DOMAIN + String(responseOperationId), 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Observer-independent commit identity hash. NOT keyed by the install key —
 * two different installs observing the same commit must produce the same
 * fingerprint (same_commit_multi_observer_v1, duplicate_diff_v1).
 */
function commitFingerprint({
  commitSha, parentSha, addedLines, deletedLines,
}) {
  const input = `${COMMIT_FINGERPRINT_DOMAIN}${commitSha}\0${parentSha ?? ''}\0`
    + `${GIT_EVIDENCE_MERGE_POLICY}\0${addedLines}\0${deletedLines}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function isNonEmptyWithin(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && byteLength(value) <= maxBytes;
}

function isLowerHexExact(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
}

function isLowerHexRange(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max && /^[0-9a-f]+$/.test(value);
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonNilUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) && value.toLowerCase() !== NIL_UUID;
}

function scanDisallowedGitEvidenceField(value, memberName) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanDisallowedGitEvidenceField(item, memberName);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [name, member] of Object.entries(value)) {
      if (GIT_EVIDENCE_DISALLOWED_FIELD_NAMES.includes(name.toLowerCase())) return name;
      const found = scanDisallowedGitEvidenceField(member, name);
      if (found) return found;
    }
    return null;
  }
  if (
    typeof value === 'string'
    && memberName
    && GIT_EVIDENCE_ENUM_BEARING_MEMBER_NAMES.includes(memberName)
    && value.toLowerCase() === GIT_EVIDENCE_DISALLOWED_VALUE
  ) return GIT_EVIDENCE_DISALLOWED_VALUE;
  return null;
}

/**
 * @param {{
 *   eventId, observedAt, sessionId, clientEventId,
 *   hostPromptId?, serverPromptId?, responseOperationId?, subSessionId?, sequence?,
 *   repository: { host, ownerPath, name, rootFingerprint, branch?, head?, dirty?, phase },
 *   diff?: { baseHead?, head?, ancestry, coverage, reason?,
 *            excludedBinaryCount, excludedSubmoduleCount, commits: [...] }
 * }} input
 * @returns {object|null} the wire object, or null when validation fails
 */
function buildGitEvidenceEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const repo = input.repository;
  if (!repo || typeof repo !== 'object') return null;

  const repository = {
    host: repo.host,
    owner_path: repo.ownerPath,
    name: repo.name,
    root_fingerprint: repo.rootFingerprint,
    ...(repo.branch != null ? { branch: repo.branch } : {}),
    ...(repo.head != null ? { head: repo.head } : {}),
    ...(repo.dirty != null ? { dirty: repo.dirty } : {}),
    phase: repo.phase,
  };

  const event = {
    schema_version: GIT_EVIDENCE_SCHEMA_VERSION,
    event_id: input.eventId,
    event_type: 'committed_change_observation',
    observed_at: input.observedAt,
    session_id: input.sessionId,
    client_event_id: input.clientEventId,
    ...(input.hostPromptId != null ? { host_prompt_id: input.hostPromptId } : {}),
    ...(input.serverPromptId != null ? { server_prompt_id: input.serverPromptId } : {}),
    ...(input.responseOperationId != null ? { response_operation_id: input.responseOperationId } : {}),
    ...(input.subSessionId != null ? { sub_session_id: input.subSessionId } : {}),
    ...(input.sequence != null ? { sequence: input.sequence } : {}),
    repository,
  };

  if (input.diff && typeof input.diff === 'object') {
    const diff = input.diff;
    event.diff = {
      ...(diff.baseHead != null ? { base_head: diff.baseHead } : {}),
      ...(diff.head != null ? { head: diff.head } : {}),
      diff_policy_version: GIT_EVIDENCE_DIFF_POLICY_VERSION,
      ancestry: diff.ancestry,
      coverage: diff.coverage,
      ...(diff.reason != null ? { reason: diff.reason } : {}),
      excluded_binary_count: diff.excludedBinaryCount,
      excluded_submodule_count: diff.excludedSubmoduleCount,
      commits: Array.isArray(diff.commits) ? diff.commits.map((commit) => ({
        commit_sha: commit.commitSha,
        ...(commit.parentSha != null ? { parent_sha: commit.parentSha } : {}),
        fingerprint: commit.fingerprint,
        added_lines: commit.addedLines,
        deleted_lines: commit.deletedLines,
        merge_policy: GIT_EVIDENCE_MERGE_POLICY,
      })) : [],
    };
  }

  return validateGitEvidenceEvent(event) === null ? event : null;
}

/** Small `coverage: 'unavailable'`, empty-commits replacement for a budget overflow. */
function buildUnavailableGitEvidenceEvent(baseEvent, reason) {
  if (!baseEvent || typeof baseEvent !== 'object') return null;
  const priorDiff = (baseEvent.diff && typeof baseEvent.diff === 'object') ? baseEvent.diff : {};
  return {
    ...baseEvent,
    diff: {
      ...(priorDiff.base_head != null ? { base_head: priorDiff.base_head } : {}),
      ...(priorDiff.head != null ? { head: priorDiff.head } : {}),
      diff_policy_version: GIT_EVIDENCE_DIFF_POLICY_VERSION,
      ancestry: priorDiff.ancestry || 'unknown',
      coverage: 'unavailable',
      reason,
      excluded_binary_count: 0,
      excluded_submodule_count: 0,
      commits: [],
    },
  };
}

/**
 * Mirrors the Rust `validate()` rule table, in the same order. Returns null
 * when valid, else a short machine-readable reason string.
 */
function validateGitEvidenceEvent(event) {
  if (!event || typeof event !== 'object') return 'invalid_event';
  if (event.schema_version !== GIT_EVIDENCE_SCHEMA_VERSION) return 'unknown_schema_version';
  if (!isNonNilUuid(event.event_id)) return 'invalid_event_id';
  if (!GIT_EVIDENCE_EVENT_TYPES.includes(event.event_type)) return 'invalid_event_type';
  if (!isNonEmptyWithin(event.session_id, MAX_GIT_EVIDENCE_SESSION_ID_BYTES)) return 'invalid_session_id';
  if (!isNonEmptyWithin(event.client_event_id, MAX_GIT_EVIDENCE_HOST_PROMPT_ID_BYTES)) return 'invalid_client_event_id';
  if (
    event.host_prompt_id !== undefined
    && !isNonEmptyWithin(event.host_prompt_id, MAX_GIT_EVIDENCE_HOST_PROMPT_ID_BYTES)
  ) return 'invalid_host_prompt_id';
  if (event.server_prompt_id !== undefined && !isNonNilUuid(event.server_prompt_id)) return 'invalid_server_prompt_id';
  if (
    event.response_operation_id !== undefined
    && !isNonEmptyWithin(event.response_operation_id, MAX_GIT_EVIDENCE_HOST_PROMPT_ID_BYTES)
  ) return 'invalid_response_operation_id';
  if (event.sub_session_id !== undefined && !isNonNilUuid(event.sub_session_id)) return 'invalid_sub_session_id';
  if (event.sequence !== undefined && (!Number.isSafeInteger(event.sequence) || event.sequence < 0)) return 'invalid_sequence';

  const repository = event.repository;
  if (!repository || typeof repository !== 'object') return 'invalid_repository';
  if (
    !isNonEmptyWithin(repository.host, MAX_GIT_EVIDENCE_HOST_BYTES)
    || /[A-Z]/.test(repository.host)
    || /[@/?#:]/.test(repository.host)
  ) return 'invalid_repository_host';
  if (
    !isNonEmptyWithin(repository.owner_path, MAX_GIT_EVIDENCE_OWNER_PATH_BYTES)
    || repository.owner_path.startsWith('/')
    || repository.owner_path.endsWith('/')
    || repository.owner_path.includes('//')
    || repository.owner_path.split('/').includes('..')
    || /[@?#:]/.test(repository.owner_path)
  ) return 'invalid_repository_owner_path';
  if (
    !isNonEmptyWithin(repository.name, MAX_GIT_EVIDENCE_REPOSITORY_BYTES)
    || repository.name.includes('/')
    || repository.name.includes('\\')
    || repository.name.includes('..')
    || /[@?#:]/.test(repository.name)
  ) return 'invalid_repository_name';
  if (!isLowerHexExact(repository.root_fingerprint, 64)) return 'invalid_root_fingerprint';
  if (
    repository.branch !== undefined
    && (typeof repository.branch !== 'string' || byteLength(repository.branch) > MAX_GIT_EVIDENCE_BRANCH_BYTES)
  ) return 'invalid_repository_branch';
  if (repository.head !== undefined && !isLowerHexRange(repository.head, 40, 64)) return 'invalid_repository_head';
  if (!GIT_EVIDENCE_PHASES.includes(repository.phase)) return 'invalid_repository_phase';

  const diff = event.diff;
  if (diff !== undefined) {
    if (!diff || typeof diff !== 'object') return 'invalid_diff';
    if (diff.diff_policy_version !== GIT_EVIDENCE_DIFF_POLICY_VERSION) return 'unknown_diff_policy_version';
    if (diff.base_head !== undefined && !isLowerHexRange(diff.base_head, 40, 64)) return 'invalid_diff_base_head';
    if (diff.head !== undefined && !isLowerHexRange(diff.head, 40, 64)) return 'invalid_diff_head';
    if (!Number.isSafeInteger(diff.excluded_binary_count) || diff.excluded_binary_count < 0) return 'invalid_excluded_binary_count';
    if (!Number.isSafeInteger(diff.excluded_submodule_count) || diff.excluded_submodule_count < 0) return 'invalid_excluded_submodule_count';
    if (!Array.isArray(diff.commits) || diff.commits.length > MAX_GIT_EVIDENCE_COMMITS) return 'commit_limit_exceeded';

    // Coverage/reason agreement is checked before the commit loop, mirroring
    // the Rust `validate()` order — an event whose coverage/reason pairing
    // is already invalid is rejected before any per-commit field is read.
    if (diff.coverage === 'ready') {
      if (diff.reason !== undefined) return 'unexpected_reason';
    } else if (GIT_EVIDENCE_DIFF_COVERAGE.includes(diff.coverage)) {
      if (diff.reason === undefined || !GIT_EVIDENCE_DIFF_REASONS.includes(diff.reason)) return 'missing_or_invalid_reason';
    } else {
      return 'invalid_coverage';
    }
    if (diff.coverage === 'unavailable' && diff.commits.length > 0) return 'commits_present_when_unavailable';

    const seenShas = new Set();
    for (const commit of diff.commits) {
      if (!commit || typeof commit !== 'object') return 'invalid_commit';
      if (!isLowerHexRange(commit.commit_sha, 40, 64)) return 'invalid_commit_sha';
      if (commit.parent_sha !== undefined && !isLowerHexRange(commit.parent_sha, 40, 64)) return 'invalid_parent_sha';
      if (!isLowerHexExact(commit.fingerprint, 64)) return 'invalid_commit_fingerprint';
      if (!Number.isSafeInteger(commit.added_lines) || commit.added_lines < 0) return 'invalid_added_lines';
      if (!Number.isSafeInteger(commit.deleted_lines) || commit.deleted_lines < 0) return 'invalid_deleted_lines';
      if (seenShas.has(commit.commit_sha)) return 'duplicate_commit';
      seenShas.add(commit.commit_sha);
    }
  }

  if (event.event_type === 'committed_change_observation' && diff === undefined) return 'missing_diff';

  const disallowedField = scanDisallowedGitEvidenceField(event, null);
  if (disallowedField) return `disallowed_field:${disallowedField}`;

  return null;
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
  GIT_EVIDENCE_SCHEMA_VERSION,
  GIT_EVIDENCE_ENDPOINT_PATH,
  GIT_EVIDENCE_DIFF_POLICY_VERSION,
  GIT_EVIDENCE_MERGE_POLICY,
  MAX_GIT_EVIDENCE_REQUEST_BYTES,
  MAX_GIT_EVIDENCE_COMMITS,
  MAX_GIT_EVIDENCE_RESPONSE_BYTES,
  MAX_GIT_EVIDENCE_SESSION_ID_BYTES,
  MAX_GIT_EVIDENCE_HOST_PROMPT_ID_BYTES,
  MAX_GIT_EVIDENCE_HOST_BYTES,
  MAX_GIT_EVIDENCE_OWNER_PATH_BYTES,
  MAX_GIT_EVIDENCE_REPOSITORY_BYTES,
  MAX_GIT_EVIDENCE_BRANCH_BYTES,
  GIT_EVIDENCE_EVENT_TYPES,
  GIT_EVIDENCE_PHASES,
  GIT_EVIDENCE_ANCESTRY,
  GIT_EVIDENCE_DIFF_COVERAGE,
  GIT_EVIDENCE_DIFF_REASONS,
  GIT_EVIDENCE_LOCAL_TERMINAL_REASONS,
  GIT_EVIDENCE_ERROR_CODES,
  GIT_EVIDENCE_BODY_TOO_LARGE_TEXT,
  GIT_EVIDENCE_DISALLOWED_FIELD_NAMES,
  canonicalJson,
  deriveEvidenceEventId,
  commitFingerprint,
  buildGitEvidenceEvent,
  buildUnavailableGitEvidenceEvent,
  validateGitEvidenceEvent,
};
