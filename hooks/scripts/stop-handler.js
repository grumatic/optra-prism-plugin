#!/usr/bin/env node
/**
 * Stop first publishes a minimal immutable response intent. Transcript and
 * realtime work happen only after that intent is durable.
 */

const crypto = require('crypto');
const { readStdin } = require('../../lib/stdin');
const {
  readTurn,
  updateSummary,
  validServerPromptId,
  publishAndConsumeActive,
} = require('../../lib/session');
const {
  MAX_ENTRY_BYTES,
  enqueueDetailed,
  serializedEntryBytes,
  drain,
  replayPrompt,
} = require('../../lib/response-outbox');
const { validHostPromptId } = require('../../lib/host-prompt-id');

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
  const responsePayload = {
    tool_session_id: data.session_id,
    prompt_id: active.serverPromptId,
    client_event_id: active.clientEventId,
    host_prompt_id: active.submitPromptId,
    response_operation_id: responseOperationId(data, active),
    response_text: responseText,
    // The plugin sends the full response text untruncated today, so this is
    // evidence about that body, not a record of client-side truncation.
    original_char_count: responseText.length,
    untruncated_sha256: sha256(responseText),
    truncated: false,
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
  }
}

main().catch(() => {});
