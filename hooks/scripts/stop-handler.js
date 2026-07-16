#!/usr/bin/env node
/**
 * Stop correlation is intentionally exact: a captured submit must match this
 * host Stop prompt_id, its epoch, and a bounded transcript turn proof before
 * the active record is consumed. There is no cross-turn or session fallback.
 */

const crypto = require('crypto');
const { API_KEY, INGEST_URL, SHOW_REALTIME_SUMMARY } = require('../../lib/env');
const { readStdin } = require('../../lib/stdin');
const { sendResponse } = require('../../lib/ingest');
const { readTurn, consumeActive, updateSummary } = require('../../lib/session');
const {
  validPromptId,
  proveTranscriptTurn,
  consumeUsage,
  buildSystemMessage,
  assistantContentHash,
  isOpusModel,
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

function summaryUpdate(summary, proof, submittedAt) {
  const validUsage = proof.usage.filter(Boolean);
  const invalidUsage = validUsage.length !== proof.usage.length;
  const { totals, addedIds } = consumeUsage(validUsage, summary.processedUsageIds);
  const last = proof.usage.at(-1);
  const previous = summary.contextHealth;
  const elapsed = Math.max(0, Date.now() - submittedAt);
  const contextHealth = last ? {
    ...previous,
    turnCount: (previous.turnCount || 0) + 1,
    firstInputTokens: previous.firstInputTokens || (last.input + last.cacheRead + last.cacheCreation),
    lastInputTokens: last.input + last.cacheRead + last.cacheCreation,
    responseTimes: [...(previous.responseTimes || []), elapsed].slice(-50),
    opusLowOutputCount: (previous.opusLowOutputCount || 0)
      // One increment per newly consumed usage identity, even when a turn
      // replays multiple records that share the same stable id.
      + addedIds.filter((id) => {
        const usage = validUsage.find((item) => item.id === id);
        return usage && isOpusModel(usage.model) && usage.output < 200;
      }).length,
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
  })) return;

  if (!API_KEY || !INGEST_URL) {
    emitSystemMessage('[Prism] Realtime summary unavailable: ingest is not configured.');
    return;
  }

  const validUsage = proof.usage.filter(Boolean);
  const { totals } = consumeUsage(validUsage, []);
  let response;
  try {
    response = await sendResponse({
      tool_session_id: data.session_id,
      client_event_id: active.clientEventId,
      response_text: typeof data.last_assistant_message === 'string' ? data.last_assistant_message : '',
      input_tokens: totals.input,
      output_tokens: totals.output,
      cost_usd: totals.unknownCost || validUsage.length !== proof.usage.length ? undefined : totals.cost,
    });
  } catch {
    emitSystemMessage('[Prism] Realtime summary unavailable: response capture failed.');
    return;
  }
  if (response.status < 200 || response.status >= 300) {
    emitSystemMessage('[Prism] Realtime summary unavailable: response capture failed.');
    return;
  }

  const summary = updateSummary(data.session_id, (current) => summaryUpdate(current, proof, Date.parse(active.submittedAt)));
  if (summary) emitSystemMessage(buildSystemMessage(summary));
}

main().catch(() => {});
