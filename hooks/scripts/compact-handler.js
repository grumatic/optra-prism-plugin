#!/usr/bin/env node
/**
 * --- PostCompact Hook ---
 *
 * Resets legacy context-management counters and advances the isolated session
 * lifecycle/compact records when Claude supplies a session identity.
 */

const { readStdin } = require('../../lib/stdin');
const {
  advanceCompactBarrier,
  readState,
  writeState,
} = require('../../lib/session');

function resetLegacyState() {
  const state = readState();
  state.turnCount = 0;
  state.firstTurnInputTokens = 0;
  state.lastTurnInputTokens = 0;
  state.responseTimes = [];
  state.opusLowOutputCount = 0;
  state.modelCounts = {};
  state.totalCost = 0;
  state.lastCacheData = null;
  state.pendingStatusLine = null;
  state.pendingAlerts = null;
  writeState(state);
}

readStdin().then((data) => {
  if (data && data.session_id) advanceCompactBarrier(data.session_id);
  resetLegacyState();
}).catch(() => {
  resetLegacyState();
});
