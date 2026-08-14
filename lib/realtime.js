const crypto = require('crypto');
const fs = require('fs');
const { rateFor, timestamp } = require('./model-catalog');

const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const TRANSCRIPT_RETRIES = 3;
const TRANSCRIPT_RETRY_MS = 150;


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
  const cacheCreationBreakdown = usage.cache_creation ?? usage.cacheCreation;
  const cacheCreation5m = cacheCreationBreakdown?.ephemeral_5m_input_tokens
    ?? cacheCreationBreakdown?.ephemeral5mInputTokens;
  const cacheCreation1h = cacheCreationBreakdown?.ephemeral_1h_input_tokens
    ?? cacheCreationBreakdown?.ephemeral1hInputTokens;
  // Claude Code's default cache TTL is 5 minutes and transcripts may omit the
  // breakdown entirely; an absent breakdown prices under an all-5-minute
  // assumption. A valid split is carried through so a non-zero 1h bucket can
  // be priced at the catalog's 1h rate; a malformed breakdown stays unpriced.
  const breakdownPresent = Boolean(cacheCreationBreakdown && typeof cacheCreationBreakdown === 'object');
  const splitValid = breakdownPresent
    && [cacheCreation5m, cacheCreation1h].every((value) => Number.isFinite(value) && value >= 0)
    && cacheCreation5m + cacheCreation1h === cacheCreation;
  const cacheSplit = cacheCreation === 0 || !breakdownPresent
    ? null
    : splitValid
      ? { fiveMinute: cacheCreation5m, oneHour: cacheCreation1h }
      : 'invalid';
  return {
    input,
    cacheRead,
    cacheCreation,
    cacheSplit,
    output,
    model: message.model || record.model || null,
    occurredAt: timestamp(record.timestamp),
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

function consumeUsage(usage, processedUsageIds, catalog) {
  const processed = new Set(Array.isArray(processedUsageIds) ? processedUsageIds : []);
  const totals = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0, cost: 0, unknownCost: false };
  const addedIds = [];
  let pricedRevision = null;
  for (const item of Array.isArray(usage) ? usage : []) {
    if (processed.has(item.id)) continue;
    processed.add(item.id);
    addedIds.push(item.id);
    totals.input += item.input;
    totals.cacheRead += item.cacheRead;
    totals.cacheCreation += item.cacheCreation;
    totals.output += item.output;
    if (item.cacheSplit === 'invalid') {
      totals.unknownCost = true;
      continue;
    }
    const rate = rateFor(catalog, item.model, item.occurredAt);
    if (!rate) {
      totals.unknownCost = true;
      continue;
    }
    // A valid split prices each write interval at its own rate; without one
    // the whole write bucket takes the 5m rate (Claude Code's default TTL).
    let cacheWriteCost;
    if (item.cacheSplit === null || item.cacheSplit === undefined) {
      cacheWriteCost = item.cacheCreation * rate.cacheWrite;
    } else if (item.cacheSplit.oneHour === 0) {
      cacheWriteCost = item.cacheSplit.fiveMinute * rate.cacheWrite;
    } else if (rate.cacheWrite1h !== null) {
      cacheWriteCost = item.cacheSplit.fiveMinute * rate.cacheWrite
        + item.cacheSplit.oneHour * rate.cacheWrite1h;
    } else {
      totals.unknownCost = true;
      continue;
    }
    pricedRevision = rate.revision;
    totals.cost += (item.input * rate.input
      + item.cacheRead * rate.cacheRead
      + cacheWriteCost
      + item.output * rate.output) / 1_000_000;
  }
  if (pricedRevision !== null && !totals.unknownCost) totals.costCatalogRevision = pricedRevision;
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

function formatCost(cost, unavailable) {
  if (unavailable) return 'cost n/a';
  const value = cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2);
  return `$${value}`;
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
  usageFromRecord,
  consumeUsage,
  selectScoreRow,
  mapTurnRange,
  renderScoreLine,
  assistantContentHash,
  MAX_TRANSCRIPT_BYTES,
  formatCost,
};
