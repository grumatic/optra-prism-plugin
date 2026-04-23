#!/usr/bin/env node
/**
 * --- Stop Hook ---
 *
 * Runs when Claude stops. Builds a compact status line and saves it to
 * session state for the submit handler to display on the next turn:
 *   [Prism] 5.2s · 12K in / 2K out · $0.23 ($1.45 total) · turn 5
 *
 * Stop hook stderr is not displayed by Claude Code, so the status line
 * and alerts are stored in state.pendingStatusLine / state.pendingAlerts
 * and emitted by the submit handler (UserPromptSubmit stderr IS visible).
 *
 * Cost is cache-aware: queries OTEL telemetry for cache_read_tokens and
 * cache_creation_tokens, stores the cache rate in session state, and applies
 * it to subsequent turns. Falls back to full input pricing if no cache data.
 *
 * Input (stdin JSON from Claude Code):
 *   { session_id, last_assistant_message, stop_hook_active, cwd, hook_event_name,
 *     input_tokens, output_tokens, model, ... }
 *
 * Output:
 *   exit 0 --- allow Claude to stop
 */

const { createDebug } = require('../../lib/debug');
const { GCK_KEY, SHOW_STATUS_LINE } = require('../../lib/env');
const { readStdin } = require('../../lib/stdin');
const { sendResponse } = require('../../lib/ingest');
const { fetchTelemetryLogs } = require('../../lib/engine');
const { readState, writeState } = require('../../lib/session');

const debug = createDebug('stop-handler');

// ─── Model pricing ($ per million tokens) ───

const MODEL_PRICING = {
  'claude-opus-4-6':            { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-5-20250514':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5-20250514': { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':  { input: 0.25,  output: 1.25,  cacheRead: 0.025, cacheWrite: 0.3125 },
};

function getModelPricing(model) {
  if (!model) return null;
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key.split('-').slice(0, 3).join('-'))) return pricing;
  }
  if (/opus/i.test(model))  return MODEL_PRICING['claude-opus-4-6'];
  if (/sonnet/i.test(model)) return MODEL_PRICING['claude-sonnet-4-6'];
  if (/haiku/i.test(model)) return MODEL_PRICING['claude-haiku-4-5-20251001'];
  return null;
}

/**
 * Compute cost with cache-aware pricing.
 * @param {number} inputTokens - total input tokens (from stop hook)
 * @param {number} outputTokens - total output tokens
 * @param {string} model - model name
 * @param {object|null} cacheData - { cacheReadTokens, cacheCreationTokens } from OTEL
 */
function computeCost(inputTokens, outputTokens, model, cacheData) {
  const pricing = getModelPricing(model);
  if (!pricing) return null;

  const M = 1_000_000;

  if (cacheData && (cacheData.cacheReadTokens > 0 || cacheData.cacheCreationTokens > 0)) {
    const cacheRead = cacheData.cacheReadTokens || 0;
    const cacheWrite = cacheData.cacheCreationTokens || 0;
    const uncached = Math.max(0, inputTokens - cacheRead - cacheWrite);

    return (uncached / M) * pricing.input
      + (cacheRead / M) * pricing.cacheRead
      + (cacheWrite / M) * pricing.cacheWrite
      + (outputTokens / M) * pricing.output;
  }

  // No cache data — full input price (conservative)
  return (inputTokens / M) * pricing.input + (outputTokens / M) * pricing.output;
}

function formatCost(cost) {
  if (cost === null) return null;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1.00) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

readStdin().then(async (data) => {
  debug(`HOOK FIRED session_id=${data.session_id || '(none)'} gck=${GCK_KEY ? 'set' : 'missing'}`);
  debug(`STDIN DATA: input_tokens=${data.input_tokens} output_tokens=${data.output_tokens} model=${data.model} keys=[${Object.keys(data).join(',')}]`);

  const state = readState();
  debug(`STATE READ: turnCount=${state.turnCount} lastPromptTimestamp=${state.lastPromptTimestamp} SHOW_STATUS_LINE=${SHOW_STATUS_LINE}`);

  // --- Update turn counter and token stats ---
  state.turnCount = (state.turnCount || 0) + 1;
  state.sessionId = state.sessionId || data.session_id || '';

  if (data.input_tokens) {
    state.totalInputTokens = (state.totalInputTokens || 0) + (data.input_tokens || 0);
    state.totalOutputTokens = (state.totalOutputTokens || 0) + (data.output_tokens || 0);
    if (!state.firstTurnInputTokens && state.turnCount === 1) {
      state.firstTurnInputTokens = data.input_tokens || 0;
    }
    state.lastTurnInputTokens = data.input_tokens || 0;
  }

  // Track model usage
  if (data.model) {
    state.modelCounts = state.modelCounts || {};
    state.modelCounts[data.model] = (state.modelCounts[data.model] || 0) + 1;
    if (/opus/i.test(data.model) && (data.output_tokens || 0) < 200) {
      state.opusLowOutputCount = (state.opusLowOutputCount || 0) + 1;
    }
  }

  // --- Compute cost using cached OTEL data from previous turn ---
  const cacheData = state.lastCacheData || null;
  const turnCost = computeCost(data.input_tokens || 0, data.output_tokens || 0, data.model, cacheData);
  if (turnCost !== null) {
    state.totalCost = (state.totalCost || 0) + turnCost;
  }

  // --- Measure prompt-to-response time ---
  const promptTs = state.lastPromptTimestamp || 0;
  const now = Date.now();
  let elapsedMs = 0;

  if (promptTs > 0) {
    elapsedMs = now - promptTs;
    state.responseTimes = state.responseTimes || [];
    state.responseTimes.push(elapsedMs);
    if (state.responseTimes.length > 50) {
      state.responseTimes = state.responseTimes.slice(-50);
    }
  }
  state.lastPromptTimestamp = 0;

  // --- Build the status line ---
  const parts = [];

  // Response time (color-coded)
  if (elapsedMs > 0) {
    const sec = (elapsedMs / 1000).toFixed(1);
    const color = elapsedMs < 5000 ? '\x1b[32m' : elapsedMs < 15000 ? '\x1b[33m' : '\x1b[31m';
    parts.push(`${color}${sec}s\x1b[0m`);
  }

  // Tokens (this turn)
  if (data.input_tokens || data.output_tokens) {
    const inK = `${(data.input_tokens / 1000).toFixed(0)}K in`;
    const outK = `${(data.output_tokens / 1000).toFixed(0)}K out`;
    parts.push(`\x1b[2m${inK} / ${outK}\x1b[0m`);
  }

  // Cost (this turn + session total)
  if (turnCost !== null) {
    const turnStr = formatCost(turnCost);
    const totalStr = formatCost(state.totalCost || 0);
    const cacheLabel = cacheData ? '' : '\x1b[2m~\x1b[0m';
    parts.push(`\x1b[2m${cacheLabel}${turnStr} (${totalStr} total)\x1b[0m`);
  }

  // Turn count
  parts.push(`\x1b[2mturn ${state.turnCount}\x1b[0m`);

  // --- Build the status line string (saved for submit handler to display) ---
  debug(`STATUS LINE parts=${parts.length} SHOW_STATUS_LINE=${SHOW_STATUS_LINE} elapsedMs=${elapsedMs} turnCost=${turnCost}`);
  if (SHOW_STATUS_LINE && parts.length > 0) {
    state.pendingStatusLine = `[Prism] ${parts.join(' \u00b7 ')}`;
    debug(`SAVED pendingStatusLine: ${state.pendingStatusLine.replace(/\x1b\[[0-9;]*m/g, '')}`);
  } else {
    state.pendingStatusLine = null;
    debug('NO pendingStatusLine saved');
  }

  // --- Context growth alerts (periodic, not every turn) ---
  const alerts = [];
  const turnCount = state.turnCount;
  const firstInput = state.firstTurnInputTokens || 0;
  const lastInput = state.lastTurnInputTokens || 0;
  const growth = firstInput > 0 && lastInput > 0 ? lastInput / firstInput : 0;

  if ((turnCount > 80 || growth > 10) && turnCount % 5 === 0) {
    alerts.push(`\x1b[31m[Prism] Session is ${turnCount} turns deep${growth > 0 ? `, context grew ${growth.toFixed(1)}x` : ''} \u2014 consider /clear.\x1b[0m`);
  } else if (growth > 3 && turnCount > 10 && turnCount % 5 === 0) {
    alerts.push(`\x1b[33m[Prism] Context grew ${growth.toFixed(1)}x over ${turnCount} turns \u2014 run /compact.\x1b[0m`);
  } else if (turnCount > 0 && turnCount % 15 === 0) {
    alerts.push(`\x1b[2m[Prism] ${turnCount} turns \u2014 /compact frees context and saves tokens.\x1b[0m`);
  }

  // Model overkill check (every 10 turns)
  if (turnCount > 0 && turnCount % 10 === 0 && state.opusLowOutputCount >= 3) {
    const opusCount = Object.entries(state.modelCounts || {})
      .filter(([k]) => /opus/i.test(k))
      .reduce((sum, [, v]) => sum + v, 0);
    if (opusCount > 0) {
      alerts.push(`\x1b[2m[Prism] ${state.opusLowOutputCount}/${opusCount} Opus turns produced <200 tokens \u2014 try /model sonnet for simple tasks.\x1b[0m`);
    }
  }

  // Slow response warning
  if (state.responseTimes && state.responseTimes.length >= 3) {
    const recent = state.responseTimes.slice(-3);
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avgRecent > 20000 && turnCount % 5 === 0) {
      alerts.push(`\x1b[33m[Prism] Avg response time ${(avgRecent / 1000).toFixed(0)}s over last 3 turns \u2014 context may be too large. Try /compact.\x1b[0m`);
    }
  }

  // Save alerts for submit handler to display
  state.pendingAlerts = alerts.length > 0 ? alerts : null;
  debug(`ALERTS: ${alerts.length} alert(s)`);

  // Save state (submit handler reads pendingStatusLine + pendingAlerts)
  writeState(state);

  debug(`STATE SAVED: turn=${state.turnCount} pendingStatusLine=${state.pendingStatusLine ? 'yes' : 'no'} pendingAlerts=${state.pendingAlerts ? state.pendingAlerts.length : 0}`);

  // --- Async: capture response + query OTEL cache data for next turn ---
  const asyncTasks = [];

  if (GCK_KEY) {
    asyncTasks.push(
      sendResponse({
        tool_session_id: data.session_id,
        response_text: (data.last_assistant_message || '').slice(0, 2000),
        elapsed_ms: elapsedMs || 0,
        input_tokens: data.input_tokens || undefined,
        output_tokens: data.output_tokens || undefined,
        model: data.model || undefined,
        cost_usd: turnCost !== null ? turnCost : undefined,
      }).catch((err) => debug(`INGEST ERROR: ${err.message || err}`))
    );

    // Query OTEL for this session's cache data (stored for next turn's cost calc)
    asyncTasks.push(
      fetchCacheData(data.session_id, state).catch((err) => debug(`CACHE QUERY ERROR: ${err.message || err}`))
    );
  }

  await Promise.all(asyncTasks);
  process.exit(0);

}).catch((err) => {
  debug(`FATAL: ${err.message || err}`);
  process.exit(0);
});

// ─── Query OTEL telemetry for cache token data ───

async function fetchCacheData(sessionId, currentState) {
  if (!sessionId) return;

  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await fetchTelemetryLogs({
    session_id: sessionId,
    from,
    limit: 5,
  });

  if (!result.ok || !result.data || !result.data.records) {
    debug('CACHE QUERY: no data');
    return;
  }

  // Aggregate cache data from recent events
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalInput = 0;

  for (const rec of result.data.records) {
    totalCacheRead += rec.cache_read_tokens || 0;
    totalCacheWrite += rec.cache_creation_tokens || 0;
    totalInput += rec.input_tokens || 0;
  }

  if (totalInput > 0) {
    const cacheData = {
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheWrite,
      totalInputTokens: totalInput,
      cacheRate: (totalCacheRead + totalCacheWrite) / totalInput,
      updatedAt: Date.now(),
    };

    // Write cache data to session state for next turn
    const state = readState();
    state.lastCacheData = cacheData;
    writeState(state);

    debug(`CACHE DATA: read=${totalCacheRead} write=${totalCacheWrite} rate=${cacheData.cacheRate.toFixed(2)}`);
  }
}
