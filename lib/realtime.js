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

// Rubric-only family heuristic (never used for billing).
function isOpusModel(model) {
  return typeof model === 'string' && /opus/i.test(model);
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

function gradeFor(contextHealth) {
  const first = contextHealth.firstInputTokens || 0;
  const last = contextHealth.lastInputTokens || 0;
  const growth = first > 0 ? last / first : 0;
  let score = 10;
  if (growth > 10) score -= 3;
  else if (growth > 3) score -= 1.5;
  if (contextHealth.turnCount > 80) score -= 2;
  else if (contextHealth.turnCount > 20) score -= 0.5;
  const latency = contextHealth.responseTimes || [];
  if (latency.length >= 3 && latency.slice(-3).reduce((sum, value) => sum + value, 0) / 3 > 20_000) score -= 1;
  if ((contextHealth.opusLowOutputCount || 0) >= 3) score -= 0.5;
  score = Math.max(0, Math.min(10, score));
  const bands = [[0, 3, 'F'], [3, 5, 'D'], [5, 6, 'C'], [6, 6.5, 'C+'], [6.5, 7, 'B-'], [7, 8, 'B'], [8, 8.5, 'B+'], [8.5, 9, 'A-'], [9, 9.5, 'A'], [9.5, 10.000001, 'A+']];
  return { score, grade: bands.find(([from, to]) => score >= from && score < to)[2], growth };
}

function formatCost(cost, approximate) {
  // No priced usage at all: show an unpriced marker instead of a misleading
  // "~$0.0000" (unknown-model cost is never displayed as a number).
  if (approximate && cost === 0) return 'cost n/a';
  const value = cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2);
  return `${approximate ? '~' : ''}$${value}`;
}

function buildSystemMessage(summary) {
  const health = summary.contextHealth;
  const { grade } = gradeFor(health);
  const total = summary.consumedTotals.cost || 0;
  const context = health.lastInputTokens && health.contextWindow ? Math.min(100, Math.round((health.lastInputTokens / health.contextWindow) * 100)) : 0;
  return `[Prism] Lite ${grade} · ${formatCost(total, summary.consumedTotals.unknownCost)} · ctx ${context}% · turn ${health.turnCount || 0}`;
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

module.exports = { validPromptId, proveTranscriptTurn, consumeUsage, gradeFor, buildSystemMessage, assistantContentHash, MAX_TRANSCRIPT_BYTES, pricingFor, isOpusModel };
