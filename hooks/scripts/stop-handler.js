#!/usr/bin/env node
/**
 * Stop correlation is intentionally exact: a captured submit must match this
 * host Stop prompt_id, its epoch, and a bounded transcript turn proof before
 * the active record is consumed. There is no cross-turn or session fallback.
 */

const crypto = require('crypto');
const { API_KEY, INGEST_URL, SHOW_REALTIME_SUMMARY, DATA_DIR } = require('../../lib/env');
const { readStdin } = require('../../lib/stdin');
const { sendResponse, fetchRealtimeSubSessions } = require('../../lib/ingest');
const { readTurn, consumeActive, updateSummary } = require('../../lib/session');
const { loadCatalog } = require('../../lib/model-catalog');
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

function summaryUpdate(summary, proof, catalog) {
  const validUsage = proof.usage.filter(Boolean);
  const invalidUsage = validUsage.length !== proof.usage.length;
  const { totals, addedIds } = consumeUsage(validUsage, summary.processedUsageIds, catalog);
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

function assistantModel(record) {
  const message = record && record.message;
  if (message && typeof message.model === 'string') return message.model;
  return record && typeof record.model === 'string' ? record.model : undefined;
}

async function main() {
  const catalog = loadCatalog(DATA_DIR, INGEST_URL);
  const data = await readStdin();
  if (!data || typeof data.session_id !== 'string' || !validPromptId(data.prompt_id)) return;
  const turn = readTurn(data.session_id);
  if (!activeIsEligible(turn, data)) return;

  const active = turn.active;
  const proof = await proveTranscriptTurn({
    transcriptPath: data.transcript_path,
    boundary: active.transcriptBoundary,
    promptId: data.prompt_id,
  });
  const lastHash = proof && assistantContentHash(proof.assistants.at(-1));
  if (!proof || !lastHash || lastHash !== sha256(data.last_assistant_message)) return;

  // The compare-and-swap is deliberately after every no-side-effect check and
  // before network I/O; a failed response is not retried by proximity.
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
    const updated = summaryUpdate(current, proof, catalog);
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

  const validUsage = proof.usage.filter(Boolean);
  const usageComplete = validUsage.length === proof.usage.length;
  const { totals } = consumeUsage(validUsage, [], catalog);
  const realtimeRequest = fetchRealtimeSubSessions({ claudeSessionId: data.session_id, limit: 5 });
  let response;
  let rows;
  try {
    [response, rows] = await Promise.all([
      sendResponse({
        tool_session_id: data.session_id,
        prompt_id: active.serverPromptId,
        client_event_id: active.clientEventId,
        response_text: typeof data.last_assistant_message === 'string' ? data.last_assistant_message : '',
        model: assistantModel(proof.assistants.at(-1)),
        ...(usageComplete ? {
          input_tokens: totals.input,
          output_tokens: totals.output,
          cache_read_tokens: totals.cacheRead,
          cache_creation_tokens: totals.cacheCreation,
        } : {}),
        ...(usageComplete && !totals.unknownCost ? {
          cost_usd: totals.cost,
          cost_catalog_revision: totals.costCatalogRevision,
          cost_kind: 'public_list_price_estimate',
        } : {}),
      }),
      realtimeRequest,
    ]);
  } catch {
    emitSystemMessage('[Prism] Realtime summary unavailable: response capture failed.');
    return;
  }
  if (response.status < 200 || response.status >= 300) {
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
