#!/usr/bin/env node
/**
 * Stop correlation is intentionally exact: a captured submit must match this
 * host Stop prompt_id, its epoch, and a bounded transcript turn proof before
 * the active record is consumed. There is no cross-turn or session fallback.
 */

const crypto = require('crypto');
const { API_KEY, INGEST_URL, SHOW_REALTIME_SUMMARY } = require('../../lib/env');
const { readStdin } = require('../../lib/stdin');
const { sendPrompt, sendResponse, fetchRealtimeSubSessions } = require('../../lib/ingest');
const { readTurn, consumeActive, updateSummary, promoteActive, validServerPromptId } = require('../../lib/session');
const { enqueue, drain, replayPrompt } = require('../../lib/response-outbox');
const {
  validPromptId,
  proveTranscriptTurn,
  consumeUsage,
  selectScoreRow,
  mapTurnRange,
  renderScoreLine,
  assistantContentHash,
} = require('../../lib/realtime');

const ACTIVE_TTL_MS = 30 * 60 * 1000;

function sha256(value) {
  return typeof value === 'string' ? crypto.createHash('sha256').update(value).digest('hex') : null;
}
function responseOperationId(data, active) {
  return sha256(`${data.session_id}\n${active.clientEventId}\n${active.submitPromptId}`);
}

function persistedServerPromptId(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed && validServerPromptId(parsed.id) ? parsed.id : null;
  } catch {
    return null;
  }
}
function isTerminalDroppedPromptAck(body) {
  try {
    return JSON.parse(body).id === '00000000-0000-0000-0000-000000000000';
  } catch {
    return false;
  }
}

function promptIsPromoted(entry, serverPromptId) {
  const promotion = entry.promotion;
  if (!promotion) return true;
  if (!serverPromptId) return false;
  const promoted = promoteActive(
    promotion.sessionId,
    promotion.clientEventId,
    promotion.hostPromptId,
    serverPromptId,
  );
  if (promoted) return true;
  const turn = readTurn(promotion.sessionId);
  return Boolean(
    turn
    && turn.epoch === promotion.epoch
    && turn.active
    && turn.active.clientEventId === promotion.clientEventId
    && turn.active.submitPromptId === promotion.hostPromptId
    && turn.active.serverPromptId === serverPromptId
    && ['captured', 'consumed'].includes(turn.active.status),
  );
}

async function deliverOutboxEntry(entry, options = {}) {
  const result = await (entry.kind === 'prompt'
    ? sendPrompt(entry.payload, options)
    : sendResponse(entry.payload, options));
  if (entry.kind !== 'prompt' || !result || result.status < 200 || result.status >= 300) return result;
  return {
    ...result,
    // Ingest uses 200 plus the nil UUID for intentionally dropped internal
    // utility prompts. It is terminal, but must not promote a server prompt id.
    ack: isTerminalDroppedPromptAck(result.body)
      || promptIsPromoted(entry, persistedServerPromptId(result.body)),
  };
}

async function drainOutbox(prioritizeIds = []) {
  return drain(deliverOutboxEntry, { limit: 32, maxElapsedMs: 2000, prioritizeIds });
}

function emitSystemMessage(message) {
  if (SHOW_REALTIME_SUMMARY && message) process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
}

function activeIsEligible(turn, data) {
  const active = turn && turn.active;
  if (!active || turn.kind !== 'normal-pending' || active.status !== 'captured') return false;
  if (!validPromptId(data.prompt_id) || !validPromptId(active.submitPromptId) || active.submitPromptId !== data.prompt_id) return false;
  const submittedAt = Date.parse(active.submittedAt);
  return Number.isFinite(submittedAt) && Date.now() - submittedAt >= 0 && Date.now() - submittedAt <= ACTIVE_TTL_MS;
}
function activeIsSubmitting(turn, data) {
  const active = turn && turn.active;
  return Boolean(
    active
    && turn.kind === 'normal-pending'
    && active.status === 'submitting'
    && validPromptId(data.prompt_id)
    && validPromptId(active.submitPromptId)
    && active.submitPromptId === data.prompt_id,
  );
}

async function recoverSubmittingTurn(turn, data) {
  if (!activeIsSubmitting(turn, data)) return turn;

  const active = turn.active;
  const outcomes = await replayPrompt({
    sessionId: data.session_id,
    epoch: turn.epoch,
    clientEventId: active.clientEventId,
    hostPromptId: active.submitPromptId,
  }, deliverOutboxEntry, { maxElapsedMs: 2000 });
  if (!outcomes.some((outcome) => outcome.acked)) return null;
  return readTurn(data.session_id);
}

function summaryUpdate(summary, proof) {
  const validUsage = proof.usage.filter(Boolean);
  const invalidUsage = validUsage.length !== proof.usage.length;
  const { totals, addedIds } = consumeUsage(validUsage, summary.processedUsageIds);
  const last = proof.usage.at(-1);
  const previous = summary.contextHealth;
  const contextHealth = last ? {
    ...previous,
    turnCount: (previous.turnCount || 0) + 1,
  } : previous;
  return {
    ...summary,
    consumedTotals: {
      input: summary.consumedTotals.input + totals.input,
      cacheRead: summary.consumedTotals.cacheRead + totals.cacheRead,
      cacheCreation: summary.consumedTotals.cacheCreation + totals.cacheCreation,
      output: summary.consumedTotals.output + totals.output,
      cost: summary.consumedTotals.cost + totals.cost,
      unknownCost: summary.consumedTotals.unknownCost || totals.unknownCost || invalidUsage,
    },
    processedUsageIds: [...summary.processedUsageIds, ...addedIds].slice(-500),
    contextHealth,
  };
}

async function main() {
  const data = await readStdin();
  if (!data || typeof data.session_id !== 'string' || !validPromptId(data.prompt_id)) return;
  let turn = readTurn(data.session_id);
  turn = await recoverSubmittingTurn(turn, data);
  if (!turn || !activeIsEligible(turn, data)) return;

  const active = turn.active;
  const proof = await proveTranscriptTurn({
    transcriptPath: data.transcript_path,
    boundary: active.transcriptBoundary,
    promptId: data.prompt_id,
  });
  const lastHash = proof && assistantContentHash(proof.assistants.at(-1));
  if (!proof || !lastHash || lastHash !== sha256(data.last_assistant_message)) return;

  const validUsage = proof.usage.filter(Boolean);
  const { totals } = consumeUsage(validUsage, []);
  const responsePayload = {
    tool_session_id: data.session_id,
    prompt_id: active.serverPromptId,
    client_event_id: active.clientEventId,
    host_prompt_id: active.submitPromptId,
    response_text: typeof data.last_assistant_message === 'string' ? data.last_assistant_message : '',
    input_tokens: totals.input,
    output_tokens: totals.output,
    cache_read_tokens: totals.cacheRead,
    cache_creation_tokens: totals.cacheCreation,
    model: validUsage.at(-1) && validUsage.at(-1).model ? validUsage.at(-1).model : undefined,
    cost_usd: totals.unknownCost || validUsage.length !== proof.usage.length ? undefined : totals.cost,
  };
  responsePayload.response_operation_id = responseOperationId(data, active);
  if (!enqueue({
    id: responsePayload.response_operation_id,
    kind: 'response',
    payload: responsePayload,
  })) return;

  // The response intent is durable before the compare-and-swap consumes the
  // active turn, so a transport failure is replayed by the next hook run.
  if (!consumeActive(data.session_id, {
    epoch: turn.epoch,
    clientEventId: active.clientEventId,
    submitPromptId: active.submitPromptId,
    serverPromptId: active.serverPromptId,
  })) return;

  // Local accounting is finalized once the exactly correlated turn is consumed.
  // `processedUsageIds` keeps this safe if state is replayed.
  const completedAt = new Date().toISOString();
  const summary = updateSummary(data.session_id, (current) => {
    const updated = summaryUpdate(current, proof);
    return {
      ...updated,
      turnLog: [
        ...(updated.turnLog || []),
        { turn: updated.contextHealth.turnCount, completedAt },
      ].slice(-50),
    };
  });
  if (!API_KEY || !INGEST_URL) {
    emitSystemMessage('[Prism] Realtime summary unavailable: ingest is not configured.');
    return;
  }

  const realtimeRequest = fetchRealtimeSubSessions({ claudeSessionId: data.session_id, limit: 5 });
  const [outcomes, rows] = await Promise.all([
    drainOutbox([responsePayload.response_operation_id]),
    realtimeRequest,
  ]);
  const delivered = outcomes.find((outcome) => outcome.id === responsePayload.response_operation_id);
  if (!delivered || !delivered.acked) {
    emitSystemMessage('[Prism] Realtime summary unavailable: response capture failed.');
    return;
  }

  let serverScore;
  if (Array.isArray(rows)) {
    const selected = selectScoreRow(rows);
    if (selected) {
      const range = mapTurnRange(
        summary && summary.turnLog,
        selected.row,
        summary && summary.contextHealth.turnCount,
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
      if (stored) serverScore = stored.serverScore;
    } else {
      serverScore = { state: 'scoring' };
    }
  } else {
    serverScore = summary && summary.serverScore ? summary.serverScore : { state: 'no score' };
  }

  const display = summary || {
    consumedTotals: { cost: totals.cost, unknownCost: totals.unknownCost },
    contextHealth: { turnCount: 0 },
  };
  emitSystemMessage(renderScoreLine(
    serverScore,
    display.consumedTotals.cost,
    display.consumedTotals.unknownCost,
    display.contextHealth.turnCount,
  ));
}

main().catch(() => {});
