/**
 * Shared outbox sender used by every hook drainer. Response classification and
 * terminal isolation remain inside response-outbox; this module only adds the
 * durable prompt-to-session promotion acknowledgement.
 */

const { sendPrompt, sendResponse, sendPromptEvidence } = require('./ingest');
const {
  promoteActive,
  promoteLegacyActive,
  readTurn,
  validServerPromptId,
} = require('./session');

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

function exactPromptIsPromoted(promotion, serverPromptId) {
  if (!serverPromptId) return false;
  const promoted = promoteActive(
    promotion.sessionId,
    promotion.clientEventId,
    promotion.hostPromptId,
    serverPromptId,
  );
  if (promoted) return true;
  const turn = readTurn(promotion.sessionId);
  if (turn && turn.epoch > promotion.epoch) return true;
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

function legacyPromptIsPromoted(promotion, serverPromptId) {
  if (!serverPromptId) return false;
  const promoted = promoteLegacyActive(
    promotion.sessionId,
    promotion.clientEventId,
    promotion.epoch,
    serverPromptId,
  );
  if (promoted) return true;
  const turn = readTurn(promotion.sessionId);
  if (
    !turn
    || turn.epoch !== promotion.epoch
    || !turn.active
    || turn.active.clientEventId !== promotion.clientEventId
    || turn.active.submitPromptId !== undefined
  ) return true;
  return Boolean(
    turn
    && turn.epoch === promotion.epoch
    && turn.active
    && turn.active.clientEventId === promotion.clientEventId
    && turn.active.submitPromptId === undefined
    && turn.active.serverPromptId === serverPromptId
    && ['captured', 'consumed'].includes(turn.active.status),
  );
}

function promptIsPromoted(entry, serverPromptId) {
  if (entry.promotion) return exactPromptIsPromoted(entry.promotion, serverPromptId);
  if (entry.legacyPromotion) return legacyPromptIsPromoted(entry.legacyPromotion, serverPromptId);
  return true;
}

function isExactPromptEvidenceAck(result, clientEventId) {
  if (!result || result.status !== 200 || result.mediaType !== 'application/json') return false;
  const body = result.body;
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 4096) return false;
  try {
    const value = JSON.parse(body);
    return Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === 4
      && value.ack_version === 1
      && typeof value.client_event_id === 'string'
      && value.client_event_id === clientEventId
      && typeof value.occurrence_id === 'string'
      && value.occurrence_id.length > 0
      && value.status === 'accepted',
    );
  } catch {
    return false;
  }
}

async function deliverOutboxEntry(entry, options = {}) {
  const result = await (entry.kind === 'prompt'
    ? sendPrompt(entry.payload, options)
    : entry.kind === 'prompt_evidence'
      ? sendPromptEvidence(entry.payload, options)
      : sendResponse(entry.payload, options));
  if (entry.kind === 'prompt_evidence') {
    return {
      ...result,
      ack: isExactPromptEvidenceAck(result, entry.payload.client_event_id),
    };
  }
  if (entry.kind !== 'prompt' || !result || result.status < 200 || result.status >= 300) return result;
  return {
    ...result,
    ack: isTerminalDroppedPromptAck(result.body)
      || promptIsPromoted(entry, persistedServerPromptId(result.body)),
  };
}

module.exports = {
  deliverOutboxEntry,
  persistedServerPromptId,
  isTerminalDroppedPromptAck,
  promptIsPromoted,
  isExactPromptEvidenceAck,
};
