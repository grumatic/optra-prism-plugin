const crypto = require('crypto');
const fs = require('fs');

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const TRANSCRIPT_RETRIES = 3;
const TRANSCRIPT_RETRY_MS = 150;

// Official Claude API per-MTok rates (platform.claude.com/docs/en/about-claude/
// pricing and /models/overview, verified 2026-07-16). cacheWrite is the
// 5-minute cache write rate. Exact reviewed IDs/aliases only — no family
// fallback; unlisted models stay unpriced.
const MODEL_PRICING = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5-20251101': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // Introductory rate through 2026-08-31; standard $3/$15 afterwards.
  'claude-sonnet-5': [
    { effectiveAt: Date.UTC(2026, 0, 1), input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    { effectiveAt: Date.UTC(2026, 8, 1), input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  ],
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-4-1-20250805': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};

function validPromptId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBoundary(transcriptPath, byteOffset) {
  if (typeof transcriptPath !== 'string' || !Number.isInteger(byteOffset) || byteOffset < 0) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= byteOffset) return '';
    if (size - byteOffset > MAX_TRANSCRIPT_BYTES) return null;
    const buffer = Buffer.allocUnsafe(size - byteOffset);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, byteOffset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function isSidechain(record) {
  return Boolean(record && (record.isSidechain || (record.message && record.message.isSidechain)));
}

function recordPromptId(record) {
  // Distinguish an absent field (structural proof allowed) from an explicitly
  // present value (must match the authorized id, even when falsey/malformed).
  for (const holder of [record, record && record.message]) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of ['prompt_id', 'promptId']) {
      if (Object.prototype.hasOwnProperty.call(holder, key)) {
        return { present: true, value: holder[key] };
      }
    }
  }
  return { present: false, value: undefined };
}

function isUserRecord(record) {
  return record && (record.type === 'user' || (record.message && record.message.role === 'user'));
}

function isAssistantRecord(record) {
  return record && (record.type === 'assistant' || (record.message && record.message.role === 'assistant'));
}

function isCompleteAssistant(record) {
  const message = record.message || record;
  return !isSidechain(record) && isAssistantRecord(record) && message && (
    (Object.hasOwn(message, 'stop_reason') && message.stop_reason !== null)
    || (Object.hasOwn(message, 'stopReason') && message.stopReason !== null)
  );
}

function usageIdentity(record, fallbackOffset) {
  const message = record.message || {};
  const candidates = [message.id, record.uuid, record.id];
  const value = candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 1024);
  return value ? `id:${value}` : `offset:${fallbackOffset}`;
}

function usageFromRecord(record, fallbackOffset) {
  if (isSidechain(record)) return null;
  const message = record.message || {};
  const usage = message.usage || record.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.input_tokens ?? usage.inputTokens;
  const cacheRead = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cache_read_tokens;
  const cacheCreation = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? usage.cache_creation_tokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  if (![input, cacheRead, cacheCreation, output].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return {
    input,
    cacheRead,
    cacheCreation,
    output,
    model: message.model || record.model || null,
    id: crypto.createHash('sha256').update(usageIdentity(record, fallbackOffset)).digest('hex'),
  };
}

function parseTurn(text, promptId) {
  if (text === null || text === '') return null;
  const records = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    try { records.push({ record: JSON.parse(line), offset: lineOffset }); } catch { return null; }
  }
  const users = records.filter(({ record }) => isUserRecord(record) && !isSidechain(record));
  if (users.length !== 1) return null;
  const user = users[0];
    const userPromptId = recordPromptId(user.record);
    if (userPromptId.present && userPromptId.value !== promptId) return null;
  const trailing = records.slice(records.indexOf(user) + 1).filter(({ record }) => !isSidechain(record));
  if (trailing.some(({ record }) => isUserRecord(record))) return null;
  const assistants = trailing.filter(({ record }) => isAssistantRecord(record));
  if (assistants.length === 0 || assistants.some(({ record }) => !isCompleteAssistant(record))) return null;
  return {
    assistants: assistants.map(({ record }) => record),
    usage: assistants.map(({ record, offset: assistantOffset }) => usageFromRecord(record, assistantOffset)),
  };
}

async function proveTranscriptTurn({ transcriptPath, boundary, promptId }) {
  for (let attempt = 0; attempt < TRANSCRIPT_RETRIES; attempt += 1) {
    const proof = parseTurn(readBoundary(transcriptPath, boundary && boundary.byteOffset), promptId);
    if (proof) return proof;
    if (attempt + 1 < TRANSCRIPT_RETRIES) await sleep(TRANSCRIPT_RETRY_MS);
  }
  return null;
}

function pricingFor(model, clock = Date.now) {
  if (typeof model !== 'string') return null;
  // Claude Code appends a long-context marker (e.g. "[1m]"); 1M context is
  // billed at standard per-token rates for these models per official pricing.
  const pricing = MODEL_PRICING[model.replace(/\[1m\]$/, '')];
  if (!Array.isArray(pricing)) return pricing || null;

  const timestamp = typeof clock === 'function' ? clock() : clock;
  if (!Number.isFinite(timestamp)) return null;
  let current = null;
  for (const rate of pricing) {
    if (timestamp >= rate.effectiveAt) current = rate;
  }
  return current && {
    input: current.input,
    output: current.output,
    cacheRead: current.cacheRead,
    cacheWrite: current.cacheWrite,
  };
}


function consumeUsage(usage, processedUsageIds) {
  const processed = new Set(Array.isArray(processedUsageIds) ? processedUsageIds : []);
  const totals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, cost: 0, unknownCost: false };
  const addedIds = [];
  for (const item of usage) {
    if (processed.has(item.id)) continue;
    processed.add(item.id);
    addedIds.push(item.id);
    totals.input += item.input;
    totals.cacheRead += item.cacheRead;
    totals.cacheCreation += item.cacheCreation;
    totals.output += item.output;
    const pricing = pricingFor(item.model);
    if (!pricing) {
      totals.unknownCost = true;
      continue;
    }
    totals.cost += (item.input * pricing.input
      + item.cacheRead * pricing.cacheRead
      + item.cacheCreation * pricing.cacheWrite
      + item.output * pricing.output) / 1_000_000;
  }
  return { totals, addedIds };
}

function selectScoreRow(rows) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.substance_floor_passed === false) continue;
    if (row.is_preview === true && row.letter_grade) return { state: 'live', row };
    if (row.is_preview !== true && (row.prompt_grade || row.letter_grade)) return { state: 'settled', row };
  }
  return null;
}

function mapTurnRange(turnLog, row, fallbackTurn) {
  const fallback = Number.isSafeInteger(fallbackTurn) && fallbackTurn >= 0 ? fallbackTurn : 0;
  const entries = Array.isArray(turnLog)
    ? turnLog.filter((entry) => entry
      && Number.isSafeInteger(entry.turn)
      && entry.turn >= 0
      && Number.isFinite(Date.parse(entry.completedAt)))
    : [];
  const startedAt = Date.parse(row && row.started_at);
  const endedAt = Date.parse(row && row.ended_at);
  const starts = Number.isFinite(startedAt)
    ? entries.filter((entry) => Date.parse(entry.completedAt) >= startedAt).map((entry) => entry.turn)
    : [];
  const ends = row && row.is_preview === true
    ? entries.map((entry) => entry.turn)
    : Number.isFinite(endedAt)
      ? entries.filter((entry) => Date.parse(entry.completedAt) <= endedAt).map((entry) => entry.turn)
      : [];
  return {
    turnStart: starts.length > 0 ? Math.min(...starts) : fallback,
    turnEnd: ends.length > 0 ? Math.max(...ends) : fallback,
  };
}

function formatCost(cost, approximate) {
  // No priced usage at all: show an unpriced marker instead of a misleading
  // "~$0.0000" (unknown-model cost is never displayed as a number).
  if (approximate && cost === 0) return 'cost n/a';
  const value = cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2);
  return `${approximate ? '~' : ''}$${value}`;
}

function renderScoreLine(serverScore, cost, approximateCost, turnCount) {
  const state = serverScore && serverScore.state;
  const formattedCost = formatCost(Number.isFinite(cost) && cost >= 0 ? cost : 0, approximateCost === true);
  const turns = Number.isSafeInteger(turnCount) && turnCount >= 0 ? turnCount : 0;
  if (state === 'scoring') return `[Prism] scoring… · ${formattedCost} · ${turns} turns`;
  if (state !== 'live' && state !== 'settled') return `[Prism] no score · ${formattedCost} · ${turns} turns`;

  const turnStart = Number.isSafeInteger(serverScore.turnStart) ? serverScore.turnStart : turns;
  const turnEnd = Number.isSafeInteger(serverScore.turnEnd) ? serverScore.turnEnd : turns;
  const range = turnStart === turnEnd ? `(t${turnStart})` : `(t${turnStart}–${turnEnd})`;
  const segments = [`[Prism] ${serverScore.grade}${state === 'live' ? ' live' : ''}`];
  if (typeof serverScore.intent === 'string' && serverScore.intent.length > 0) {
    const markers = state === 'settled'
      ? `${serverScore.goalComplete === true ? ' ✓' : ''}${serverScore.rework === true ? ' ↺' : ''}`
      : '';
    // The turn range binds to the graded work, so it attaches to the intent
    // segment without a separator: `refactor ✓ (t8–10)`.
    segments.push(`${serverScore.intent.replace(/_/g, '-')}${markers} ${range}`);
  } else {
    segments.push(range);
  }
  segments.push(formattedCost, `${turns} turns`);
  return segments.join(' · ');
}

function assistantContentHash(record) {
  if (isSidechain(record)) return null;
  const content = (record.message || record).content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((part) => part && typeof part.text === 'string').map((part) => part.text).join('')
      : '';
  return text ? crypto.createHash('sha256').update(text).digest('hex') : null;
}

module.exports = {
  validPromptId,
  proveTranscriptTurn,
  consumeUsage,
  selectScoreRow,
  mapTurnRange,
  renderScoreLine,
  assistantContentHash,
  MAX_TRANSCRIPT_BYTES,
  pricingFor,
  formatCost,
};
