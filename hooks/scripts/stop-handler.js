#!/usr/bin/env node
/**
 * Stop first publishes a minimal immutable response intent. Transcript and
 * realtime work happen only after that intent is durable.
 */

const fs = require('fs');
const crypto = require('crypto');
const { readStdin } = require('../../lib/stdin');
const { MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES, clampToWireLimit } = require('../../lib/body-clamp');
const {
  readTurn,
  updateSummary,
  validServerPromptId,
  publishAndConsumeActive,
  readGit,
  readGitCapture,
  clearGitCapture,
  readTurnBaselines,
  turnBaselinesMatch,
  clearTurnBaselines,
  readLeaveCaptures,
  appendLeaveCapture,
  settleLeaveCaptureRoots,
  leaveCaptureKey,
  MAX_LEAVE_CAPTURE_ATTEMPTS,
} = require('../../lib/session');
const {
  MAX_ENTRY_BYTES,
  enqueueDetailed,
  serializedEntryBytes,
  drain,
  replayPrompt,
} = require('../../lib/response-outbox');
const { validHostPromptId } = require('../../lib/host-prompt-id');
// The git-evidence/v1 modules are required lazily, inside the functions that
// use them (matching the outbox-delivery / model-catalog pattern elsewhere
// in this hook), not at module top level.

// Enough to clear a backlog left while delivery waited for a refresh within a
// few turns; this turn's own entry is still sent first (prioritizeIds).
const STOP_EVIDENCE_DRAIN_LIMIT = 8;
const STOP_EVIDENCE_DRAIN_ELAPSED_MS = 1000;

function logEvidenceSkip(sessionId, reason) {
  try { require('../../lib/git-evidence-skip-log').logEvidenceSkip(sessionId, reason); } catch {}
}

// Refreshes the capability cache when due (one request every five minutes
// at most), after the response is published. Never throws.
async function refreshCapabilityIfDue() {
  try { await require('../../lib/git-evidence-capability').refreshCapability(); } catch {}
}

// Worktrees a turn left are reported after its own Stop event, with a budget
// of their own: a large Stop root can take the whole collection deadline.
const LEAVE_COLLECT_DEADLINE_MS = 2000;
const MAX_LEAVE_ROOTS_PER_TURN = 4;
// Reading the heads of left roots no hook saw the turn leave, right after
// the response is published and before it is sent.
const LEAVE_RECORD_HEAD_DEADLINE_MS = 250;

function sha256(value) {
  return typeof value === 'string' ? crypto.createHash('sha256').update(value).digest('hex') : null;
}

function responseOperationId(data, active) {
  return sha256(`${data.session_id}\n${active.clientEventId}\n${active.submitPromptId}`);
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function reportLocalGap(reason, serializedBytes, operationId) {
  const size = Number.isSafeInteger(serializedBytes) ? ` bytes=${serializedBytes}` : '';
  const operation = typeof operationId === 'string' ? ` operation=${operationId}` : '';
  process.stderr.write(`[Prism] Response capture pending: ${reason}.${size}${operation}\n`);
}

function recordActiveAge(active, operationId) {
  const submittedAt = active && Date.parse(active.submittedAt);
  const age = Date.now() - submittedAt;
  if (!Number.isFinite(age) || typeof operationId !== 'string') return;
  try {
    const { createDebug } = require('../../lib/debug');
    createDebug('stop-handler')(
      `STOP durable publication operation_id=${operationId} active_age_ms=${Math.max(0, Math.trunc(age))}`,
    );
  } catch {}
}

function activeIsEligible(turn, data) {
  const active = turn && turn.active;
  return Boolean(
    active
    && turn.kind === 'normal-pending'
    && active.status === 'captured'
    && validServerPromptId(active.serverPromptId)
    && validHostPromptId(data.prompt_id)
    && validHostPromptId(active.submitPromptId)
    && active.submitPromptId === data.prompt_id,
  );
}

function activeIsSubmitting(turn, data) {
  const active = turn && turn.active;
  return Boolean(
    active
    && turn.kind === 'normal-pending'
    && active.status === 'submitting'
    && validHostPromptId(data.prompt_id)
    && validHostPromptId(active.submitPromptId)
    && active.submitPromptId === data.prompt_id,
  );
}

function activeIsConsumedEligible(turn, data) {
  const active = turn && turn.active;
  return Boolean(
    active
    && turn.kind === 'normal-pending'
    && active.status === 'consumed'
    && validServerPromptId(active.serverPromptId)
    && validHostPromptId(data.prompt_id)
    && validHostPromptId(active.submitPromptId)
    && active.submitPromptId === data.prompt_id,
  );
}

async function recoverSubmittingTurn(turn, data) {
  if (!activeIsSubmitting(turn, data)) return turn;
  const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
  const active = turn.active;
  const outcomes = await replayPrompt({
    sessionId: data.session_id,
    epoch: turn.epoch,
    clientEventId: active.clientEventId,
    hostPromptId: active.submitPromptId,
  }, deliverOutboxEntry, { maxElapsedMs: 2000 });
  const recovered = readTurn(data.session_id);
  if (outcomes.some((outcome) => outcome.acked) || activeIsEligible(recovered, data)) return recovered;
  return null;
}

function minimalResponseEntry(data, turn) {
  const active = turn.active;
  const responseText = data.last_assistant_message;
  const clampedResponseText = clampToWireLimit(responseText, MAX_PROMPT_BODY_BYTES, MAX_WIRE_BYTES);
  const responsePayload = {
    tool_session_id: data.session_id,
    prompt_id: active.serverPromptId,
    client_event_id: active.clientEventId,
    host_prompt_id: active.submitPromptId,
    response_operation_id: responseOperationId(data, active),
    response_text: clampedResponseText,
    original_char_count: responseText.length,
    untruncated_sha256: sha256(responseText),
    truncated: clampedResponseText !== responseText,
  };
  return {
    id: responsePayload.response_operation_id,
    kind: 'response',
    payload: responsePayload,
    deliveryFence: {
      sessionId: data.session_id,
      epoch: turn.epoch,
      clientEventId: active.clientEventId,
      submitPromptId: active.submitPromptId,
      serverPromptId: active.serverPromptId,
    },
    createdAt: new Date().toISOString(),
  };
}

// A `.git` entry between the directory and that root marks a nested worktree,
// repository or submodule that was never recorded (an EnterWorktree worktree
// lives under its main checkout), so the root does not stand in for it.
function enclosingRecordedRoot(record, realCwd) {
  if (!record) return null;
  const path = require('path');
  const containing = record.roots
    .map((entry) => entry.root)
    .filter((root) => realCwd === root || realCwd.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));
  const root = containing.sort((left, right) => right.length - left.length)[0];
  if (!root) return null;
  for (let dir = realCwd; dir !== root; dir = path.dirname(dir)) {
    if (path.dirname(dir) === dir || fs.existsSync(path.join(dir, '.git'))) return null;
  }
  return root;
}

/**
 * The worktree roots this turn recorded a baseline for, other than the one
 * Stop runs in: commits made there would otherwise go unreported. Reads the
 * turn's own record only; no Git runs before the response is published. The
 * Stop root is the deepest recorded root containing the Stop directory, so a
 * subdirectory of the prompt root is not mistaken for a root the turn left.
 *
 * The prompt root is a candidate even when the submit-time Git read timed
 * out and left it without a baseline: it then carries the submit time
 * instead, and its baseline is read from its reflog once the response is
 * published.
 */
function leftRootsAtStop(data, active, epoch) {
  const { HEAD_PATTERN } = require('../../lib/git-evidence-contract');
  const record = readTurnBaselines(data.session_id);
  if (!turnBaselinesMatch(record, { epoch, clientEventId: active.clientEventId })) return [];
  let stopDir = null;
  if (typeof data.cwd === 'string' && data.cwd.length > 0) {
    try { stopDir = fs.realpathSync.native(data.cwd); } catch { stopDir = null; }
  } else {
    const envelope = readGit(data.session_id);
    stopDir = envelope ? envelope.canonicalCwd : null;
  }
  const promptRootUnrecorded = typeof record.promptRoot === 'string'
    && !record.roots.some((entry) => entry.root === record.promptRoot);
  const known = promptRootUnrecorded
    ? { ...record, roots: [{ root: record.promptRoot }, ...record.roots] }
    : record;
  const stopRoot = stopDir ? enclosingRecordedRoot(known, stopDir) : null;
  const left = record.roots
    .filter((entry) => entry.root !== stopRoot && HEAD_PATTERN.test(entry.head))
    .map((entry) => ({
      root: entry.root,
      baselineHead: entry.head,
      ...(entry.leftHead ? { leftHead: entry.leftHead } : {}),
    }));
  if (promptRootUnrecorded && record.promptRoot !== stopRoot) {
    left.unshift({ root: record.promptRoot, baselineAt: record.submittedAt });
  }
  return left;
}

/**
 * Right after the response is published, before the turn's baselines are
 * cleared: keeps the roots this turn left so their evidence can be collected
 * after the turn's own, and resumed if this process ends first. Added next
 * to any earlier turn still waiting. The capture gate is checked when the
 * roots are collected, after this Stop's refresh, not here.
 */
async function recordLeaveCaptures(sessionId, epoch, active, responseOperationIdValue, leftRoots) {
  if (leftRoots.length === 0) return false;
  const { readCapabilityCache, negotiatedEvidenceVersion, currentBindingDigest } = require('../../lib/git-evidence-capability');
  const { GIT_EVIDENCE_SCHEMA_VERSION_V2 } = require('../../lib/git-evidence-contract');
  const { readHead } = require('../../lib/git');
  const schemaVersion = negotiatedEvidenceVersion(readCapabilityCache());
  const bindingDigest = currentBindingDigest();
  // A root no hook saw the turn leave is bounded by its head now, at the end
  // of this turn: a later hook that collects it must not take a commit the
  // next turn made there. Only the roots that will be collected, within one
  // short budget; a root left without one falls back to its head when
  // collected.
  const deadlineAt = Date.now() + LEAVE_RECORD_HEAD_DEADLINE_MS;
  const roots = [];
  for (const [index, root] of leftRoots.entries()) {
    if (root.leftHead || index >= MAX_LEAVE_ROOTS_PER_TURN || Date.now() >= deadlineAt) {
      roots.push(root);
      continue;
    }
    const head = await readHead(root.root, { deadlineAt });
    roots.push(head ? { ...root, leftHead: head } : root);
  }
  const { written, dropped } = appendLeaveCapture(sessionId, {
    epoch,
    clientEventId: active.clientEventId,
    submitPromptId: active.submitPromptId,
    serverPromptId: active.serverPromptId,
    responseOperationId: responseOperationIdValue,
    createdAt: new Date().toISOString(),
    ...(schemaVersion === GIT_EVIDENCE_SCHEMA_VERSION_V2 ? { evidenceSchemaVersion: schemaVersion } : {}),
    ...(bindingDigest ? { bindingDigest } : {}),
    roots,
  });
  if (dropped > 0) logEvidenceSkip(sessionId, 'leave_overflow');
  return written;
}

function headObservedBySubmit(head, observedAt, active) {
  const { HEAD_PATTERN } = require('../../lib/git-evidence-contract');
  return typeof head === 'string'
    && HEAD_PATTERN.test(head)
    && Number.isFinite(Date.parse(observedAt))
    && Date.parse(observedAt) <= Date.parse(active.submittedAt);
}

// Baseline is the head the Stop directory's worktree root had when this turn
// began. No later head is substituted for it while that head can still be
// read — a record observed after submittedAt is rejected rather than
// trusted — so each step below either yields it or falls through, and the
// last one fails closed to `baseline_missing`:
//   1. The session Git record, when it still holds the prompt-time snapshot
//      of this exact directory (the common case: no move during the turn).
//   2. This turn's prompt baseline, when the Stop directory is in the
//      worktree root the prompt was submitted from (a subdirectory `cd`).
//   3. That root's reflog at submittedAt (or at its last emitted leave), for
//      any other root, whether or not a hook recorded one.
//   4. The head a hook stored on entering that root, which is the reflog
//      value when the hook could read it, and otherwise the head at entry;
//      only a root whose reflog is unreadable gets here.
// Git runs here before the response is published, so all of it shares one
// short prompt-path deadline.
async function resolveBaseline(data, active, epoch) {
  const envelope = readGit(data.session_id);
  const hasCwd = typeof data.cwd === 'string' && data.cwd.length > 0;
  let realCwd = null;
  if (hasCwd) {
    try { realCwd = fs.realpathSync.native(data.cwd); } catch { realCwd = null; }
  }
  const value = envelope && envelope.status === 'ok' ? envelope.value : null;
  const cwdMatches = hasCwd
    ? (realCwd !== null && envelope && envelope.canonicalCwd === realCwd)
    : Boolean(envelope && envelope.canonicalCwd);
  const cwd = hasCwd ? realCwd : (envelope ? envelope.canonicalCwd : null);
  if (value && cwdMatches && headObservedBySubmit(value.head, value.observed_at, active)) {
    return { baselineHead: value.head, baselineReason: null, cwd };
  }

  const missing = { baselineHead: null, baselineReason: 'baseline_missing', cwd };
  const missingBecause = (step) => {
    logEvidenceSkip(data.session_id, `baseline_missing_${step}`);
    return missing;
  };
  if (!realCwd) return missingBecause('no_cwd');
  // No Git before publication when its answer cannot matter: a directory
  // already known not to be a repository, or a service that takes no
  // evidence (the capture step drops the marker then anyway). A cache that
  // is only old still captures: delivery waits for the refresh after Stop.
  if (envelope && envelope.status === 'not_repo' && envelope.canonicalCwd === realCwd) return missingBecause('not_repo');
  const { readCapabilityCache, captureClosedReason } = require('../../lib/git-evidence-capability');
  const closed = captureClosedReason(readCapabilityCache());
  if (closed) {
    logEvidenceSkip(data.session_id, `capability_${closed}`);
    return missing;
  }

  const { resolveWorktreeRoot, resolveHeadAt, DEADLINE_MS } = require('../../lib/git');
  const candidate = readTurnBaselines(data.session_id);
  const record = turnBaselinesMatch(candidate, { epoch, clientEventId: active.clientEventId }) ? candidate : null;
  // When Git cannot name the root in time, the deepest recorded root that
  // contains the Stop directory stands in for it.
  const deadlineAt = Date.now() + DEADLINE_MS;
  const root = await resolveWorktreeRoot(realCwd, DEADLINE_MS, { deadlineAt }) || enclosingRecordedRoot(record, realCwd);
  if (!root) return missingBecause('no_root');

  const entry = record ? record.roots.find((item) => item.root === root) : null;
  const found = (head) => ({ baselineHead: head, baselineReason: null, cwd });
  if (entry && entry.source === 'prompt' && headObservedBySubmit(entry.head, entry.observedAt, active)) {
    return found(entry.head);
  }

  const at = entry && entry.emittedAt !== undefined ? entry.emittedAt : active.submittedAt;
  const reflog = await resolveHeadAt(root, at, { fallbackToCurrent: false, deadlineAt });
  if (reflog) return found(reflog.head);
  return entry && entry.source !== 'prompt' ? found(entry.head) : missingBecause('no_reflog');
}

// The body version is negotiated here, once, and pinned in the marker: a
// resumed capture must rebuild the same body under the same event_id even if
// the capability changed in between, or the server answers 409 conflict.
// Only v2 is written; a v1 marker keeps the shape older plugin versions read.
function gitCaptureMarker(epoch, active, responseOperationIdValue, baseline) {
  const { deriveEvidenceEventId, GIT_EVIDENCE_SCHEMA_VERSION_V2 } = require('../../lib/git-evidence-contract');
  const { readCapabilityCache, negotiatedEvidenceVersion } = require('../../lib/git-evidence-capability');
  const schemaVersion = negotiatedEvidenceVersion(readCapabilityCache());
  return {
    eventId: deriveEvidenceEventId(responseOperationIdValue),
    epoch,
    clientEventId: active.clientEventId,
    submitPromptId: active.submitPromptId,
    serverPromptId: active.serverPromptId,
    responseOperationId: responseOperationIdValue,
    canonicalCwd: baseline.cwd,
    baselineHead: baseline.baselineHead,
    baselineReason: baseline.baselineReason,
    createdAt: new Date().toISOString(),
    ...(schemaVersion === GIT_EVIDENCE_SCHEMA_VERSION_V2 ? { evidenceSchemaVersion: schemaVersion } : {}),
  };
}

function repositoryIdentityFromFinalState(finalState) {
  if (!finalState || finalState.status !== 'ok' || !finalState.remote || !finalState.rootFingerprint) return null;
  return {
    host: finalState.remote.host,
    ownerPath: finalState.remote.ownerPath,
    name: finalState.remote.repo,
    rootFingerprint: finalState.rootFingerprint,
    branch: finalState.branch,
    head: finalState.head,
    dirty: finalState.dirty,
  };
}

function repositoryIdentityFromPromptSnapshot(sessionId) {
  const promptGit = readGit(sessionId);
  const value = promptGit && promptGit.value;
  if (!value || !value.root_fingerprint || !value.host || !value.repo) return null;
  return {
    host: value.host,
    ownerPath: value.owner_path || value.owner,
    name: value.repo,
    rootFingerprint: value.root_fingerprint,
    branch: value.branch || undefined,
  };
}

function unavailableDiff(reason, { baseHead, head, ancestry = 'unknown' } = {}) {
  return {
    baseHead: baseHead || undefined,
    head: head || undefined,
    ancestry,
    coverage: 'unavailable',
    reason,
    excludedBinaryCount: 0,
    excludedSubmoduleCount: 0,
    commits: [],
  };
}

/**
 * Resolves a pending git-capture marker into either an enqueued
 * git-evidence/v1 entry or nothing at all — it never leaves a silent gap.
 * `skipCollection` is set only by the resume path once the marker has aged
 * past EVIDENCE_RESUME_MAX_AGE_MS: a retry must not substitute a later
 * repository state for the one Stop could not capture in time.
 */
async function captureAndEnqueueEvidence(sessionId, marker, { skipCollection = false } = {}) {
  const {
    readCapabilityCache, captureClosedReason, currentBindingDigest,
  } = require('../../lib/git-evidence-capability');
  const { EVIDENCE_COLLECT_DEADLINE_MS, collectFinalGitState, collectCommittedRange } = require('../../lib/git');
  const {
    buildGitEvidenceEvent,
    buildUnavailableGitEvidenceEvent,
    validateGitEvidenceEvent,
    canonicalJson,
    GIT_EVIDENCE_SCHEMA_VERSION,
    GIT_EVIDENCE_SCHEMA_VERSION_V2,
    MAX_GIT_EVIDENCE_COMMITS,
    MAX_GIT_EVIDENCE_REQUEST_BYTES,
  } = require('../../lib/git-evidence-contract');
  const { enqueueEvidence } = require('../../lib/git-evidence-outbox');

  // Capture outlives delivery's one-hour freshness: the entry waits in the
  // outbox for a refresh instead of being dropped here.
  const closed = captureClosedReason(readCapabilityCache());
  if (closed) {
    logEvidenceSkip(sessionId, `capability_${closed}`);
    clearGitCapture(sessionId);
    return;
  }

  // A marker without a pinned version predates v2 negotiation, or was v1.
  const schemaVersion = marker.evidenceSchemaVersion || GIT_EVIDENCE_SCHEMA_VERSION;

  // One absolute deadline shared by both collectors, so a Stop capture is
  // bounded by EVIDENCE_COLLECT_DEADLINE_MS total rather than up to double
  // that (each collector previously started its own 5s window).
  const deadlineAt = Date.now() + EVIDENCE_COLLECT_DEADLINE_MS;

  let finalState = null;
  if (!skipCollection && marker.baselineReason !== 'baseline_missing') {
    try {
      finalState = await collectFinalGitState(marker.canonicalCwd, EVIDENCE_COLLECT_DEADLINE_MS, { deadlineAt });
    } catch {
      finalState = null;
    }
  }

  const identity = repositoryIdentityFromFinalState(finalState) || repositoryIdentityFromPromptSnapshot(sessionId);
  if (!identity) {
    logEvidenceSkip(sessionId, 'no_repository');
    clearGitCapture(sessionId);
    return;
  }

  let diff;
  if (marker.baselineReason === 'baseline_missing') {
    diff = unavailableDiff('baseline_missing');
  } else if (skipCollection || !finalState || finalState.status !== 'ok') {
    diff = unavailableDiff('final_snapshot_failed', { baseHead: marker.baselineHead });
  } else {
    let range;
    try {
      range = await collectCommittedRange({
        cwd: marker.canonicalCwd,
        baselineHead: marker.baselineHead,
        finalHead: finalState.head,
        deadlineAt,
        judgeAuthors: schemaVersion === GIT_EVIDENCE_SCHEMA_VERSION_V2,
      });
    } catch {
      range = null;
    }
    diff = range
      ? diffFromRange(range, marker.baselineHead, finalState.head)
      : unavailableDiff('final_snapshot_failed', { baseHead: marker.baselineHead, head: finalState.head });
  }

  // Belt: the collector already caps a range at MAX_GIT_EVIDENCE_COMMITS
  // (converting to commit_limit_exceeded itself), but this must be checked
  // on the plain diff BEFORE buildGitEvidenceEvent — that builder rejects
  // (returns null) an over-limit event outright, so checking event.diff
  // afterward can never observe the overflow it is meant to catch.
  if (Array.isArray(diff.commits) && diff.commits.length > MAX_GIT_EVIDENCE_COMMITS) {
    diff = unavailableDiff('commit_limit_exceeded', { baseHead: diff.baseHead, head: diff.head, ancestry: diff.ancestry });
  }

  let event = buildGitEvidenceEvent({
    schemaVersion,
    eventId: marker.eventId,
    // The marker's own createdAt, not the moment this function happens to
    // run: a crash-then-resume of the same marker must reproduce byte-
    // identical canonical bytes so a redelivery is recognized as the same
    // event (200 duplicate) rather than a conflicting one (409).
    observedAt: marker.createdAt,
    sessionId,
    clientEventId: marker.clientEventId,
    hostPromptId: marker.submitPromptId,
    serverPromptId: marker.serverPromptId,
    responseOperationId: marker.responseOperationId,
    repository: { ...identity, phase: 'stop' },
    diff,
  });
  if (!event) {
    logEvidenceSkip(sessionId, 'event_build_failed');
    clearGitCapture(sessionId);
    return;
  }

  if (Buffer.byteLength(canonicalJson(event), 'utf8') > MAX_GIT_EVIDENCE_REQUEST_BYTES) {
    event = buildUnavailableGitEvidenceEvent(event, 'payload_budget_exceeded');
  }
  if (validateGitEvidenceEvent(event) !== null) {
    logEvidenceSkip(sessionId, 'event_invalid');
    clearGitCapture(sessionId);
    return;
  }

  const bindingDigest = currentBindingDigest();
  enqueueEvidence({
    eventId: event.event_id,
    schemaVersion: event.schema_version,
    observedAt: event.observed_at,
    createdAt: new Date().toISOString(),
    ...(bindingDigest ? { bindingDigest } : {}),
    correlation: {
      sessionId,
      clientEventId: marker.clientEventId,
      hostPromptId: marker.submitPromptId,
      serverPromptId: marker.serverPromptId,
      responseOperationId: marker.responseOperationId,
    },
    payload: event,
  });
  clearGitCapture(sessionId);
}

/**
 * Runs from the crash-resume Stop branch and from SessionStart: resolves
 * whatever git-capture marker this session currently owns.
 */
async function resumeEvidenceCapture(sessionId) {
  const { EVIDENCE_RESUME_MAX_AGE_MS } = require('../../lib/git');
  const marker = readGitCapture(sessionId);
  if (marker) {
    const turn = readTurn(sessionId);
    const resumable = Boolean(
      turn
      && ((turn.epoch === marker.epoch && turn.active && turn.active.status === 'consumed') || turn.epoch > marker.epoch),
    );
    if (resumable) {
      const stale = Date.now() - Date.parse(marker.createdAt) > EVIDENCE_RESUME_MAX_AGE_MS;
      await captureAndEnqueueEvidence(sessionId, marker, { skipCollection: stale });
    }
  }
  // Leave captures are written only once the response is published, so any
  // left here belong to a finished turn.
  await captureLeaveEvidence(sessionId);
}

function diffFromRange(range, baseHead, head) {
  return {
    baseHead: baseHead || undefined,
    head,
    ancestry: range.ancestry,
    coverage: range.coverage,
    reason: range.reason || undefined,
    excludedBinaryCount: range.excludedBinaryCount,
    excludedSubmoduleCount: range.excludedSubmoduleCount,
    foreignCommitFilter: range.foreignCommitFilter,
    commits: range.commits,
  };
}

/**
 * Reports the commits made in each worktree published turns left before
 * their Stop, one event per worktree that has commits, under that turn's own
 * correlation and a leave event id of its own. The range ends at the head the
 * root had when the turn left it, or, when no hook saw the turn leave, at the
 * head the Stop recorded for it. When that read failed, the head now stands
 * in only in that same Stop (`recordedBy`, its response operation id); a
 * later hook takes the head the root's reflog gives for the time the turn
 * was recorded. A turn captured under another binding is
 * settled unreported. It starts at the
 * root's baseline, or, for a prompt root recorded with only the submit time,
 * at the head its reflog gives for that time. `git status` is
 * skipped and `dirty` omitted. A root is settled once its event is queued or
 * it cannot be reported, with the reason logged; running out of time keeps
 * it for a later hook. Settled roots are removed from the record as it is
 * then, so a turn appended meanwhile is kept. Returns the event ids queued.
 */
async function captureLeaveEvidence(sessionId, { deadlineMs = LEAVE_COLLECT_DEADLINE_MS, recordedBy = null } = {}) {
  const record = readLeaveCaptures(sessionId);
  if (!record) return [];
  const { readCapabilityCache, captureClosedReason, currentBindingDigest } = require('../../lib/git-evidence-capability');
  const {
    EVIDENCE_RESUME_MAX_AGE_MS, collectFinalGitState, collectCommittedRange, resolveHeadAt,
  } = require('../../lib/git');
  const {
    buildGitEvidenceEvent,
    validateGitEvidenceEvent,
    canonicalJson,
    deriveLeaveEvidenceEventId,
    worktreeKey,
    GIT_EVIDENCE_SCHEMA_VERSION,
    GIT_EVIDENCE_SCHEMA_VERSION_V2,
    MAX_GIT_EVIDENCE_REQUEST_BYTES,
  } = require('../../lib/git-evidence-contract');
  const { enqueueEvidence } = require('../../lib/git-evidence-outbox');

  const settled = new Set();
  const closed = captureClosedReason(readCapabilityCache());
  if (closed) {
    logEvidenceSkip(sessionId, `capability_${closed}`);
    for (const turn of record.turns) for (const root of turn.roots) settled.add(leaveCaptureKey(turn, root));
    settleLeaveCaptureRoots(sessionId, settled);
    return [];
  }

  const deadlineAt = Date.now() + deadlineMs;
  const outOfTime = () => Date.now() >= deadlineAt;
  const bindingDigest = currentBindingDigest();
  const queued = [];
  const retried = new Set();

  for (const turn of record.turns) {
    const schemaVersion = turn.evidenceSchemaVersion || GIT_EVIDENCE_SCHEMA_VERSION;
    const stale = Date.now() - Date.parse(turn.createdAt) > EVIDENCE_RESUME_MAX_AGE_MS;
    // Captured under another API key or ingest: never sent to this one.
    if (turn.bindingDigest && turn.bindingDigest !== bindingDigest) {
      logEvidenceSkip(sessionId, 'binding_mismatch');
      for (const root of turn.roots) settled.add(leaveCaptureKey(turn, root));
      continue;
    }
    for (const [index, root] of turn.roots.entries()) {
      const key = leaveCaptureKey(turn, root);
      const settle = (reason) => {
        if (reason) logEvidenceSkip(sessionId, reason);
        settled.add(key);
      };
      // Kept for a later hook: logged, left in the record.
      const keep = () => logEvidenceSkip(sessionId, 'leave_budget_exhausted');

      if (index >= MAX_LEAVE_ROOTS_PER_TURN) { settle('leave_budget_exhausted'); continue; }
      // Left at the head it started from: nothing to report, no Git needed.
      if (root.leftHead && root.leftHead === root.baselineHead) { settle(null); continue; }
      if (outOfTime()) { keep(); continue; }
      if (!root.leftHead && stale) { settle('leave_stale'); continue; }

      // Running out of time while collecting this root: kept for a later
      // hook, unless it already had at least half the budget and so is
      // likely too large to fit any hook's; such a root is given up on its
      // last allowed try rather than held over, costing every hook, forever.
      const fullTry = deadlineAt - Date.now() >= deadlineMs / 2;
      const timedOut = () => {
        if (!fullTry) { keep(); return; }
        if ((root.attempts || 0) + 1 >= MAX_LEAVE_CAPTURE_ATTEMPTS) logEvidenceSkip(sessionId, 'leave_range_timeout');
        else keep();
        retried.add(key);
      };

      let state = null;
      try {
        state = await collectFinalGitState(root.root, deadlineMs, { deadlineAt, skipDirty: true });
      } catch {
        state = null;
      }
      if (!state || state.status !== 'ok' || !state.remote || !state.rootFingerprint) {
        if (outOfTime()) timedOut(); else settle('leave_root_gone');
        continue;
      }
      // Without a leftHead (the Stop's own read of it ran out of time), the
      // head now is this turn's only in the Stop that recorded the turn;
      // any later hook bounds the range at the head the root had when the
      // turn was recorded, from its reflog, so a commit the next turn made
      // there is not taken for this one's.
      let finalHead = root.leftHead;
      if (!finalHead && turn.responseOperationId === recordedBy) finalHead = state.head;
      if (!finalHead) {
        let bound = null;
        try {
          const at = new Date(Date.parse(turn.createdAt) + 1000).toISOString();
          bound = await resolveHeadAt(root.root, at, { fallbackToCurrent: true, deadlineAt });
        } catch {
          bound = null;
        }
        if (!bound) {
          if (outOfTime()) timedOut(); else settle('leave_final_head_missing');
          continue;
        }
        finalHead = bound.head;
      }

      // A prompt root the submit-time read missed: its head at submit, from
      // its own reflog. Never its current head, which may already hold the
      // turn's commits. The same time gives the same answer on a later try.
      let baselineHead = root.baselineHead;
      if (!baselineHead) {
        let resolved = null;
        try {
          resolved = await resolveHeadAt(root.root, root.baselineAt, { fallbackToCurrent: false, deadlineAt });
        } catch {
          resolved = null;
        }
        if (!resolved) {
          if (outOfTime()) timedOut(); else settle('leave_baseline_missing');
          continue;
        }
        baselineHead = resolved.head;
      }

      let range = null;
      try {
        range = await collectCommittedRange({
          cwd: root.root,
          baselineHead,
          finalHead,
          deadlineAt,
          judgeAuthors: schemaVersion === GIT_EVIDENCE_SCHEMA_VERSION_V2,
        });
      } catch {
        range = null;
      }
      if (!range) {
        if (outOfTime()) timedOut(); else settle('leave_range_failed');
        continue;
      }
      if (!Array.isArray(range.commits) || range.commits.length === 0) {
        // A range the collector could not walk comes back empty too: out of
        // time it is kept, otherwise (a rewritten history, more commits than
        // one event holds) it is settled with its reason logged. A ready
        // empty range is a worktree left without committing; the turn's own
        // Stop event already carries its snapshot.
        if (range.coverage === 'ready') settle(null);
        else if (range.reason === 'final_snapshot_failed' && outOfTime()) timedOut();
        else settle(`leave_${range.reason || 'unavailable'}`);
        continue;
      }

      const event = buildGitEvidenceEvent({
        schemaVersion,
        eventId: deriveLeaveEvidenceEventId(turn.responseOperationId, worktreeKey(root.root)),
        // Fixed at the moment the turn's leave captures were recorded, so a
        // resumed collection rebuilds the same bytes under the same id.
        observedAt: turn.createdAt,
        sessionId,
        clientEventId: turn.clientEventId,
        hostPromptId: turn.submitPromptId,
        serverPromptId: turn.serverPromptId,
        responseOperationId: turn.responseOperationId,
        repository: {
          host: state.remote.host,
          ownerPath: state.remote.ownerPath,
          name: state.remote.repo,
          rootFingerprint: state.rootFingerprint,
          branch: state.branch,
          head: finalHead,
          phase: 'stop',
        },
        diff: diffFromRange(range, baselineHead, finalHead),
      });
      if (!event) { settle('event_build_failed'); continue; }
      if (Buffer.byteLength(canonicalJson(event), 'utf8') > MAX_GIT_EVIDENCE_REQUEST_BYTES
        || validateGitEvidenceEvent(event) !== null) {
        settle('event_invalid');
        continue;
      }
      const result = enqueueEvidence({
        eventId: event.event_id,
        schemaVersion: event.schema_version,
        observedAt: event.observed_at,
        createdAt: new Date().toISOString(),
        ...((turn.bindingDigest || bindingDigest) ? { bindingDigest: turn.bindingDigest || bindingDigest } : {}),
        correlation: {
          sessionId,
          clientEventId: turn.clientEventId,
          hostPromptId: turn.submitPromptId,
          serverPromptId: turn.serverPromptId,
          responseOperationId: turn.responseOperationId,
        },
        payload: event,
      });
      if (result.outcome === 'created' || result.outcome === 'existing') {
        queued.push(event.event_id);
        settle(null);
      } else if (result.outcome === 'io_error') {
        // Kept: the next hook tries the same event again.
      } else if (result.outcome === 'conflict') {
        settle('leave_conflict');
      } else {
        // invalid, oversized and capacity_full: the outbox has already left
        // a terminal marker for the last two.
        settle(null);
      }
    }
  }

  settleLeaveCaptureRoots(sessionId, settled, retried);
  return queued;
}

function recordCompletedTurn(sessionId) {
  const completedAt = new Date().toISOString();
  return updateSummary(sessionId, (current) => {
    const contextHealth = {
      ...current.contextHealth,
      turnCount: (current.contextHealth.turnCount || 0) + 1,
    };
    return {
      ...current,
      contextHealth,
      turnLog: [
        ...(current.turnLog || []),
        { turn: contextHealth.turnCount, completedAt },
      ].slice(-50),
    };
  });
}

async function enrichAfterPublication(data, active, summary, delivered) {
  try {
    const { API_KEY, INGEST_URL, SHOW_REALTIME_SUMMARY, DATA_DIR } = require('../../lib/env');
    const { loadCatalog } = require('../../lib/model-catalog');
    const {
      proveTranscriptTurn,
      consumeUsage,
      selectScoreRow,
      mapTurnRange,
      renderScoreLine,
      assistantContentHash,
    } = require('../../lib/realtime');
    const { fetchRealtimeSubSessions } = require('../../lib/ingest');
    const catalog = loadCatalog(DATA_DIR, INGEST_URL);
    const proof = await proveTranscriptTurn({
      transcriptPath: data.transcript_path,
      boundary: active.transcriptBoundary,
      promptId: active.submitPromptId,
    });
    let updatedSummary = summary;
    let totals = { cost: 0, unknownCost: true };
    if (proof && assistantContentHash(proof.assistants.at(-1)) === sha256(data.last_assistant_message)) {
      updatedSummary = updateSummary(data.session_id, (current) => {
        const usage = proof.usage.filter(Boolean);
        const { totals: added, addedIds } = consumeUsage(usage, current.processedUsageIds, catalog);
        totals = added;
        return {
          ...current,
          consumedTotals: {
            input: current.consumedTotals.input + added.input,
            cacheRead: current.consumedTotals.cacheRead + added.cacheRead,
            cacheCreation: current.consumedTotals.cacheCreation + added.cacheCreation,
            output: current.consumedTotals.output + added.output,
            cost: current.consumedTotals.cost + added.cost,
            unknownCost: current.consumedTotals.unknownCost || added.unknownCost || usage.length !== proof.usage.length,
          },
          processedUsageIds: [...current.processedUsageIds, ...addedIds].slice(-500),
        };
      }) || updatedSummary;
    }
    // Best-effort host observation collection (design §5.3: Stop is the
    // first of three read points). Runs regardless of SHOW_REALTIME_SUMMARY
    // and must never affect the realtime enrichment below.
    try {
      const { readPluginVersion } = require('../../lib/plugin-version');
      const { collectAndEnqueueHostObservations, enqueueStopContext } = require('../../lib/host-observation-collection');
      const collectorVersion = readPluginVersion();
      const stopObservedAt = new Date().toISOString();
      const collected = collectAndEnqueueHostObservations({
        sessionId: data.session_id,
        transcriptPath: data.transcript_path,
        byteOffset: active.transcriptBoundary && active.transcriptBoundary.byteOffset,
        hostPromptId: active.submitPromptId,
        clientEventId: active.clientEventId,
        promptOutboxId: `prompt-${active.clientEventId}`,
        collectorVersion,
        observedAt: stopObservedAt,
      });
      const enqueuedIds = collected.ok ? [...collected.enqueuedIds] : [];
      const stopContextId = enqueueStopContext({
        sessionId: data.session_id,
        data,
        hostPromptId: active.submitPromptId,
        collectorVersion,
        hostVersion: collected.ok ? collected.hostVersion : null,
        observedAt: stopObservedAt,
      });
      if (stopContextId) enqueuedIds.push(stopContextId);

      // main()'s own drain() already ran before this function was called, so
      // these freshly-enqueued entries need their own small, separately
      // budgeted delivery attempt — enqueue first (already durable above),
      // then send them via prioritizeIds. drain() always attempts any other
      // pending response/prompt ahead of evidence-tier entries regardless of
      // prioritizeIds (by design — those are the durable, user-facing
      // records), so the limit floor here keeps that headroom instead of
      // starving our own entries behind a single stray one; it never
      // enlarges the deadline, which bounds real elapsed time on its own.
      if (enqueuedIds.length > 0 && API_KEY && INGEST_URL) {
        const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
        await drain(deliverOutboxEntry, { limit: Math.max(enqueuedIds.length, 8), maxElapsedMs: 500, prioritizeIds: enqueuedIds });
      }
    } catch { /* best-effort: never block realtime enrichment or Stop */ }
    if (!SHOW_REALTIME_SUMMARY) return;
    if (!API_KEY || !INGEST_URL) {
      process.stdout.write(`${JSON.stringify({ systemMessage: '[Prism] Realtime summary unavailable: ingest is not configured.' })}\n`);
      return;
    }
    if (!delivered || !delivered.acked) {
      process.stdout.write(`${JSON.stringify({ systemMessage: '[Prism] Realtime summary unavailable: response capture failed.' })}\n`);
      return;
    }
    const rows = await fetchRealtimeSubSessions({ claudeSessionId: data.session_id, limit: 5 });
    let serverScore = updatedSummary && updatedSummary.serverScore
      ? updatedSummary.serverScore
      : { state: 'no score' };
    if (Array.isArray(rows)) {
      const selected = selectScoreRow(rows);
      if (selected) {
        const range = mapTurnRange(
          updatedSummary && updatedSummary.turnLog,
          selected.row,
          updatedSummary && updatedSummary.contextHealth.turnCount,
        );
        serverScore = {
          state: selected.state,
          grade: selected.state === 'live' ? selected.row.letter_grade : (selected.row.prompt_grade || selected.row.letter_grade),
          intent: selected.row.intent_class || null,
          goalComplete: selected.row.goal_complete === true,
          rework: selected.row.rework === true,
          turnStart: range.turnStart,
          turnEnd: range.turnEnd,
          subSessionId: selected.row.sub_session_id,
          fetchedAt: new Date().toISOString(),
        };
        const stored = updateSummary(data.session_id, (current) => ({ ...current, serverScore }));
        if (stored) updatedSummary = stored;
      } else {
        serverScore = { state: 'scoring' };
      }
    }
    const display = updatedSummary || {
      consumedTotals: { cost: totals.cost, unknownCost: totals.unknownCost },
      contextHealth: { turnCount: 0 },
    };
    process.stdout.write(`${JSON.stringify({
      systemMessage: renderScoreLine(
        serverScore,
        display.consumedTotals.cost,
        display.consumedTotals.unknownCost,
        display.contextHealth.turnCount,
      ),
    })}\n`);
  } catch {}
}

async function main() {
  const data = await readStdin();
  if (
    !data
    || !validSessionId(data.session_id)
    || !validHostPromptId(data.prompt_id)
  ) return;

  let turn = readTurn(data.session_id);
  turn = await recoverSubmittingTurn(turn, data);
  if (!turn) return;
  if (activeIsConsumedEligible(turn, data)) {
    const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
    await drain(deliverOutboxEntry, {
      limit: 32,
      maxElapsedMs: 2000,
      prioritizeIds: [responseOperationId(data, turn.active)],
    });
    // The response is already published here: refresh before resume, so a
    // missing cache does not drop the marker resume is about to collect.
    await refreshCapabilityIfDue();
    try { await resumeEvidenceCapture(data.session_id); } catch {}
    try {
      const { drainEvidence } = require('../../lib/git-evidence-delivery');
      await drainEvidence({ limit: STOP_EVIDENCE_DRAIN_LIMIT, maxElapsedMs: STOP_EVIDENCE_DRAIN_ELAPSED_MS });
    } catch {}
    return;
  }
  if (!activeIsEligible(turn, data) || typeof data.last_assistant_message !== 'string') return;

  const entry = minimalResponseEntry(data, turn);
  const serializedBytes = serializedEntryBytes(entry);
  if (serializedBytes === null || serializedBytes > MAX_ENTRY_BYTES) {
    reportLocalGap('oversized response', serializedBytes, entry.id);
    return;
  }
  const active = turn.active;
  // Best-effort: a failure building the baseline/marker must never prevent
  // the response intent itself from publishing. A null marker just means
  // this turn's git-capture step (below) has nothing to work with.
  let marker = null;
  try {
    const baseline = await resolveBaseline(data, active, turn.epoch);
    marker = gitCaptureMarker(turn.epoch, active, entry.id, baseline);
  } catch {
    marker = null;
  }
  // Read before publication: the turn's baselines are cleared right after.
  let leftRoots = [];
  try { leftRoots = leftRootsAtStop(data, active, turn.epoch); } catch { leftRoots = []; }
  const publication = publishAndConsumeActive(data.session_id, {
    epoch: turn.epoch,
    clientEventId: active.clientEventId,
    submitPromptId: active.submitPromptId,
    serverPromptId: active.serverPromptId,
  }, () => {
    const result = enqueueDetailed(entry);
    return {
      // A deterministic operation already has an immutable first body. A
      // concurrent Stop with different text must consume that publication,
      // never replace it or reopen the completed turn.
      success: ['created', 'existing', 'conflict'].includes(result.outcome),
      result,
      gitCapture: marker,
    };
  });
  if (!publication || publication.state === 'not_current') return;
  if (publication.state === 'enqueue_failed') {
    const outcome = publication.publication && publication.publication.result
      ? publication.publication.result.outcome
      : 'io_error';
    reportLocalGap(outcome, serializedBytes, entry.id);
    return;
  }
  // The marker now carries this turn's baseline; the per-root record never
  // outlives its turn.
  if (publication.state === 'published') {
    try { await recordLeaveCaptures(data.session_id, turn.epoch, active, entry.id, leftRoots); } catch {}
    try { clearTurnBaselines(data.session_id); } catch {}
  }
  const summary = publication.state === 'published' ? recordCompletedTurn(data.session_id) : null;
  const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
  const outcomes = await drain(deliverOutboxEntry, {
    limit: 32,
    maxElapsedMs: 2000,
    prioritizeIds: [entry.id],
  });
  const delivered = outcomes.find((outcome) => outcome.id === entry.id);
  if (publication.state === 'published') {
    recordActiveAge(active, entry.id);
    await enrichAfterPublication(data, active, summary, delivered);
    // After the response and its enrichment are sent, before collection: a
    // turn whose binding has no cache yet (just after a key change) is
    // still collected in this Stop.
    await refreshCapabilityIfDue();
    if (marker) {
      try { await captureAndEnqueueEvidence(data.session_id, marker); } catch {}
    }
    // After the turn's own event, so that one is queued first.
    let leaveIds = [];
    try { leaveIds = await captureLeaveEvidence(data.session_id, { recordedBy: entry.id }); } catch { leaveIds = []; }
    if (marker || leaveIds.length > 0) {
      try {
        const { drainEvidence } = require('../../lib/git-evidence-delivery');
        await drainEvidence({
          limit: STOP_EVIDENCE_DRAIN_LIMIT,
          maxElapsedMs: STOP_EVIDENCE_DRAIN_ELAPSED_MS,
          prioritizeIds: [...(marker ? [marker.eventId] : []), ...leaveIds],
        });
      } catch {}
    }
  }
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  main,
  resumeEvidenceCapture,
  captureAndEnqueueEvidence,
  captureLeaveEvidence,
  resolveBaseline,
  gitCaptureMarker,
};
