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

const STOP_EVIDENCE_DRAIN_LIMIT = 1;
const STOP_EVIDENCE_DRAIN_ELAPSED_MS = 500;

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

// Baseline is the prompt-phase head for this turn. A mid-turn CwdChanged
// refresh of the session Git record must never silently substitute a later
// head as the baseline, so a record observed after submittedAt is rejected
// rather than trusted — this fails closed to `baseline_missing`.
function resolveBaseline(data, active) {
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
  const accepted = Boolean(
    envelope
    && envelope.status === 'ok'
    && value
    && typeof value.head === 'string'
    && /^[a-f0-9]{40,64}$/.test(value.head)
    && Number.isFinite(Date.parse(value.observed_at))
    && Date.parse(value.observed_at) <= Date.parse(active.submittedAt)
    && cwdMatches,
  );
  const cwd = hasCwd ? realCwd : (envelope ? envelope.canonicalCwd : null);
  if (!accepted) return { baselineHead: null, baselineReason: 'baseline_missing', cwd };
  return { baselineHead: value.head, baselineReason: null, cwd };
}

function gitCaptureMarker(epoch, active, responseOperationIdValue, baseline) {
  const { deriveEvidenceEventId } = require('../../lib/git-evidence-contract');
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
  const { readCapabilityCache, capabilityAllowsEvidence } = require('../../lib/git-evidence-capability');
  const { EVIDENCE_COLLECT_DEADLINE_MS, collectFinalGitState, collectCommittedRange } = require('../../lib/git');
  const {
    buildGitEvidenceEvent,
    buildUnavailableGitEvidenceEvent,
    validateGitEvidenceEvent,
    canonicalJson,
    MAX_GIT_EVIDENCE_COMMITS,
    MAX_GIT_EVIDENCE_REQUEST_BYTES,
  } = require('../../lib/git-evidence-contract');
  const { enqueueEvidence } = require('../../lib/git-evidence-outbox');

  if (!capabilityAllowsEvidence(readCapabilityCache())) {
    clearGitCapture(sessionId);
    return;
  }

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
        cwd: marker.canonicalCwd, baselineHead: marker.baselineHead, finalHead: finalState.head, deadlineAt,
      });
    } catch {
      range = null;
    }
    diff = range ? {
      baseHead: marker.baselineHead || undefined,
      head: finalState.head,
      ancestry: range.ancestry,
      coverage: range.coverage,
      reason: range.reason || undefined,
      excludedBinaryCount: range.excludedBinaryCount,
      excludedSubmoduleCount: range.excludedSubmoduleCount,
      commits: range.commits,
    } : unavailableDiff('final_snapshot_failed', { baseHead: marker.baselineHead, head: finalState.head });
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
    clearGitCapture(sessionId);
    return;
  }

  if (Buffer.byteLength(canonicalJson(event), 'utf8') > MAX_GIT_EVIDENCE_REQUEST_BYTES) {
    event = buildUnavailableGitEvidenceEvent(event, 'payload_budget_exceeded');
  }
  if (validateGitEvidenceEvent(event) !== null) {
    clearGitCapture(sessionId);
    return;
  }

  enqueueEvidence({
    eventId: event.event_id,
    schemaVersion: event.schema_version,
    observedAt: event.observed_at,
    createdAt: new Date().toISOString(),
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
  if (!marker) return;
  const turn = readTurn(sessionId);
  const resumable = Boolean(
    turn
    && ((turn.epoch === marker.epoch && turn.active && turn.active.status === 'consumed') || turn.epoch > marker.epoch),
  );
  if (!resumable) return;

  const stale = Date.now() - Date.parse(marker.createdAt) > EVIDENCE_RESUME_MAX_AGE_MS;
  await captureAndEnqueueEvidence(sessionId, marker, { skipCollection: stale });
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
    const baseline = resolveBaseline(data, active);
    marker = gitCaptureMarker(turn.epoch, active, entry.id, baseline);
  } catch {
    marker = null;
  }
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
    if (marker) {
      try { await captureAndEnqueueEvidence(data.session_id, marker); } catch {}
      try {
        const { drainEvidence } = require('../../lib/git-evidence-delivery');
        await drainEvidence({
          limit: STOP_EVIDENCE_DRAIN_LIMIT,
          maxElapsedMs: STOP_EVIDENCE_DRAIN_ELAPSED_MS,
          prioritizeIds: [marker.eventId],
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
  resolveBaseline,
};
