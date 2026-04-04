#!/usr/bin/env node
/**
 * --- PostCompact Hook ---
 *
 * Resets turnCount to 0 after /compact so context-management
 * nudges start fresh relative to the compacted context.
 */

const { readState, writeState } = require('../../lib/session');

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
