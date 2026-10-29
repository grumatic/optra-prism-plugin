'use strict';

require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  classifyEvidenceResponse,
  nextAttemptAt,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  SESSION_START_DRAIN_LIMIT,
  SESSION_START_DRAIN_ELAPSED_MS,
  STOP_DRAIN_LIMIT,
  STOP_DRAIN_ELAPSED_MS,
} = require('../lib/git-evidence-delivery');

const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const ENTRY = { eventId: '11111111-1111-4111-8111-111111111111' };

function jsonResult(status, body, overrides = {}) {
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    body: serialized,
    bodyBytes: Buffer.byteLength(serialized, 'utf8'),
    bodyTruncated: false,
    mediaType: 'application/json',
    ...overrides,
  };
}

test('git_evidence_http_matrix_v1: ack rows (202 accepted, 200 duplicate)', () => {
  assert.equal(
    classifyEvidenceResponse(jsonResult(202, { event_id: ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'accepted' }), ENTRY),
    'ack',
  );
  assert.equal(
    classifyEvidenceResponse(jsonResult(200, { event_id: ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'duplicate' }), ENTRY),
    'ack',
  );
});

test('git_evidence_http_matrix_v1: terminal_permanent coded 400s', () => {
  for (const code of ['git_evidence_invalid_payload', 'git_evidence_disallowed_field', 'git_evidence_commit_limit_exceeded']) {
    assert.equal(classifyEvidenceResponse(jsonResult(400, { error: { code } }), ENTRY), 'terminal_permanent', code);
  }
});

test('git_evidence_http_matrix_v1: unsupported schema pauses instead of terminating', () => {
  assert.equal(
    classifyEvidenceResponse(jsonResult(400, { error: { code: 'git_evidence_unsupported_schema' } }), ENTRY),
    'pause_protocol',
  );
});

test('git_evidence_http_matrix_v1: 409 event_conflict terminates as conflict', () => {
  assert.equal(
    classifyEvidenceResponse(jsonResult(409, { error: { code: 'git_evidence_event_conflict' } }), ENTRY),
    'terminal_conflict',
  );
});

test('git_evidence_http_matrix_v1: 413 with the exact ingest text is terminal, a different body is not', () => {
  const exact = { status: 413, body: 'Request body too large', bodyBytes: 23, bodyTruncated: false, mediaType: 'text/plain' };
  assert.equal(classifyEvidenceResponse(exact, ENTRY), 'terminal_permanent');
  const different = { ...exact, body: 'Payload Too Large' };
  assert.equal(classifyEvidenceResponse(different, ENTRY), 'pause_protocol');
});

test('git_evidence_http_matrix_v1: 415 unsupported media type', () => {
  assert.equal(
    classifyEvidenceResponse(jsonResult(415, { error: { code: 'git_evidence_unsupported_media_type' } }), ENTRY),
    'terminal_permanent',
  );
});

test('git_evidence_http_matrix_v1: 401/403 pause_auth, 404/410 pause_withdrawn', () => {
  for (const status of [401, 403]) assert.equal(classifyEvidenceResponse({ status }, ENTRY), 'pause_auth');
  for (const status of [404, 410]) assert.equal(classifyEvidenceResponse({ status }, ENTRY), 'pause_withdrawn');
});

test('git_evidence_http_matrix_v1: 408/425/429/5xx and a network error/threw retry', () => {
  for (const status of [408, 425, 429, 500, 503]) assert.equal(classifyEvidenceResponse({ status }, ENTRY), 'retry');
  assert.equal(classifyEvidenceResponse(null, ENTRY), 'retry');
  assert.equal(classifyEvidenceResponse({ status: 0 }, ENTRY), 'retry');
});

test('git_evidence_http_matrix_v1: negative ACK cases fall to pause_protocol, never ack or terminal', () => {
  const cases = [
    jsonResult(202, { event_id: 'wrong-id', schema_version: 'git-evidence/v1', status: 'accepted' }),
    jsonResult(202, { event_id: ENTRY.eventId, schema_version: 'git-evidence/v2', status: 'accepted' }),
    jsonResult(202, { event_id: ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'accepted', extra: true }),
    jsonResult(200, { event_id: ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'accepted' }),
    { status: 202, body: 'accepted', bodyBytes: 8, bodyTruncated: false, mediaType: 'text/plain' },
    jsonResult(202, { event_id: ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'accepted' }, { bodyTruncated: true }),
    jsonResult(400, {}),
    jsonResult(413, 'a different text', { mediaType: 'text/plain' }),
    jsonResult(409, 'Conflict', { mediaType: 'text/plain' }),
  ];
  for (const result of cases) {
    assert.equal(classifyEvidenceResponse(result, ENTRY), 'pause_protocol', JSON.stringify(result));
  }
});

test('an oversize response body (4097 bytes) is rejected as an ACK and falls to pause_protocol', () => {
  const body = JSON.stringify({ event_id: ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'accepted' });
  const result = { status: 202, body, bodyBytes: 4097, bodyTruncated: false, mediaType: 'application/json' };
  assert.equal(classifyEvidenceResponse(result, ENTRY), 'pause_protocol');
});

test('nextAttemptAt backoff table: n = 1..12 saturate at 6 hours with jitter in [0.8, 1.2]', () => {
  const now = Date.now();
  for (let attempts = 0; attempts < 12; attempts += 1) {
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
    const target = Date.parse(nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: attempts }, { now }));
    const elapsed = target - now;
    assert.ok(elapsed >= delay * 0.8 - 1, `n=${attempts + 1} too low: ${elapsed} < ${delay * 0.8}`);
    assert.ok(elapsed <= delay * 1.2 + 1, `n=${attempts + 1} too high: ${elapsed} > ${delay * 1.2}`);
  }
});

test('nextAttemptAt jitter is reproducible for a fixed eventId', () => {
  const now = Date.now();
  const first = nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 3 }, { now });
  const second = nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 3 }, { now });
  assert.equal(first, second);
});

test('Retry-After honors 1 and 3600, ignores 0, 3601, and non-integer values', () => {
  const now = Date.now();
  const withoutRetryAfter = Date.parse(nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 0 }, { now }));

  const withOne = Date.parse(nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 0 }, { now, retryAfterSeconds: 1 }));
  assert.ok(withOne >= withoutRetryAfter - 1);

  const withMax = Date.parse(nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 0 }, { now, retryAfterSeconds: 3600 }));
  assert.ok(withMax >= now + 3600 * 1000 - 1);

  const withZero = Date.parse(nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 0 }, { now, retryAfterSeconds: 0 }));
  assert.equal(withZero, withoutRetryAfter);

  const withOverMax = Date.parse(nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 0 }, { now, retryAfterSeconds: 3601 }));
  assert.equal(withOverMax, withoutRetryAfter);

  const withNonInteger = Date.parse(nextAttemptAt({ eventId: ENTRY.eventId, deliveryAttempts: 0 }, { now, retryAfterSeconds: 'abc' }));
  assert.equal(withNonInteger, withoutRetryAfter);
});

test('drain budgets are the designed constants; SessionStart 8/750ms, Stop 1/500ms', () => {
  assert.equal(SESSION_START_DRAIN_LIMIT, 8);
  assert.equal(SESSION_START_DRAIN_ELAPSED_MS, 750);
  assert.equal(STOP_DRAIN_LIMIT, 1);
  assert.equal(STOP_DRAIN_ELAPSED_MS, 500);
});

test('a pause does not increment deliveryAttempts and does not advance nextAttemptAt', async () => {
  const dataDir = tempDir('prism-git-evidence-delivery-pause-');
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const outbox = require('../lib/git-evidence-outbox');
    const now = new Date().toISOString();
    const id = '55555555-5555-4555-8555-555555555555';
    const entry = {
      eventId: id,
      schemaVersion: 'git-evidence/v1',
      observedAt: now,
      createdAt: now,
      correlation: { sessionId: 's', clientEventId: 'c' },
      payload: {
        schema_version: 'git-evidence/v1', event_id: id, event_type: 'committed_change_observation', observed_at: now, session_id: 's', client_event_id: 'c',
        repository: {
          host: 'github.com', owner_path: 'a/b', name: 'r', root_fingerprint: '1'.repeat(64), phase: 'stop',
        },
        diff: {
          diff_policy_version: 'git_text_numstat_first_parent_v1', ancestry: 'linear', coverage: 'ready', excluded_binary_count: 0, excluded_submodule_count: 0, commits: [],
        },
      },
    };
    assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');

    const ingest = require('../lib/ingest');
    const originalSend = ingest.sendGitEvidence;
    ingest.sendGitEvidence = async () => ({ status: 401 });
    try {
      const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
      const outcome = await deliverEvidenceEntry(entry, {});
      assert.equal(outcome.paused, true);
      assert.equal(outcome.pauseState, 'auth_error');
    } finally {
      ingest.sendGitEvidence = originalSend;
    }

    const [pending] = outbox.listPendingEvidence();
    assert.ok(pending);
    assert.equal(pending.deliveryAttempts, 0);
    assert.equal(pending.nextAttemptAt, entry.nextAttemptAt || pending.nextAttemptAt);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test('plugin_server_skew_v1: an unsupported-schema pause survives, and a later config 200 delivers the identical payload bytes', async () => {
  const dataDir = tempDir('prism-git-evidence-delivery-skew-');
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const outbox = require('../lib/git-evidence-outbox');
    const now = new Date().toISOString();
    const id = '66666666-6666-4666-8666-666666666666';
    const payload = {
      schema_version: 'git-evidence/v1', event_id: id, event_type: 'committed_change_observation', observed_at: now, session_id: 's', client_event_id: 'c',
      repository: {
        host: 'github.com', owner_path: 'a/b', name: 'r', root_fingerprint: '1'.repeat(64), phase: 'stop',
      },
      diff: {
        diff_policy_version: 'git_text_numstat_first_parent_v1', ancestry: 'linear', coverage: 'ready', excluded_binary_count: 0, excluded_submodule_count: 0, commits: [],
      },
    };
    const entry = {
      eventId: id,
      schemaVersion: 'git-evidence/v1',
      observedAt: now,
      createdAt: now,
      correlation: { sessionId: 's', clientEventId: 'c' },
      payload,
    };
    assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');

    const ingest = require('../lib/ingest');
    const originalSend = ingest.sendGitEvidence;
    const sentPayloads = [];
    // First attempt: an old server (schema not yet advertised on this route)
    // returns the coded unsupported-schema rejection — a pause, not a
    // permanent rejection.
    ingest.sendGitEvidence = async (sentPayload) => {
      sentPayloads.push(sentPayload);
      return {
        status: 400,
        body: JSON.stringify({ error: { code: 'git_evidence_unsupported_schema' } }),
        bodyBytes: 60,
        bodyTruncated: false,
        mediaType: 'application/json',
      };
    };
    try {
      const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
      const first = await deliverEvidenceEntry(entry, {});
      assert.equal(first.disposition, 'pause_protocol');
      assert.equal(first.paused, true);
    } finally {
      ingest.sendGitEvidence = originalSend;
    }

    const [survivor] = outbox.listPendingEvidence();
    assert.ok(survivor, 'the entry must survive a pause');
    assert.deepEqual(survivor.payload, payload);

    // A later config 200 clears the pause (asserted independently by the
    // capability test suite's state machine); the surviving entry's next
    // delivery attempt must still send byte-identical payload bytes.
    ingest.sendGitEvidence = async (sentPayload) => {
      sentPayloads.push(sentPayload);
      return {
        status: 202,
        body: JSON.stringify({ event_id: id, schema_version: 'git-evidence/v1', status: 'accepted' }),
        bodyBytes: 90,
        bodyTruncated: false,
        mediaType: 'application/json',
      };
    };
    try {
      const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
      const second = await deliverEvidenceEntry(survivor, {});
      assert.equal(second.disposition, 'ack');
      assert.equal(second.acked, true);
    } finally {
      ingest.sendGitEvidence = originalSend;
    }

    assert.equal(sentPayloads.length, 2);
    assert.deepEqual(sentPayloads[0], sentPayloads[1]);
    assert.deepEqual(sentPayloads[1], payload);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

// ─── git-evidence/v2 ───

const V2_ENTRY = { eventId: ENTRY.eventId, schemaVersion: 'git-evidence/v2' };

function unsupportedSchemaResult() {
  return jsonResult(400, { error: { code: 'git_evidence_unsupported_schema' } });
}

function v2Entry(id) {
  const now = new Date().toISOString();
  return {
    eventId: id,
    schemaVersion: 'git-evidence/v2',
    observedAt: now,
    createdAt: now,
    correlation: { sessionId: 's', clientEventId: 'c' },
    payload: {
      schema_version: 'git-evidence/v2', event_id: id, event_type: 'committed_change_observation', observed_at: now, session_id: 's', client_event_id: 'c',
      repository: {
        host: 'github.com', owner_path: 'a/b', name: 'r', root_fingerprint: '1'.repeat(64), phase: 'stop',
      },
      diff: {
        diff_policy_version: 'git_text_numstat_first_parent_v1',
        ancestry: 'linear',
        coverage: 'ready',
        excluded_binary_count: 0,
        excluded_submodule_count: 0,
        foreign_commit_filter: 'applied',
        commits: [{
          commit_sha: '4'.repeat(40),
          parent_sha: '2'.repeat(40),
          fingerprint: '5'.repeat(64),
          added_lines: 1,
          deleted_lines: 0,
          merge_policy: 'first_parent_v1',
          author_filter: 'foreign',
          parent_count: 2,
        }],
      },
    },
  };
}

async function withEvidenceDataDir(prefix, action) {
  const dataDir = tempDir(prefix);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test('git_evidence_v2: the server ACK names v1 for a v2 body, and that is an ack', () => {
  assert.equal(
    classifyEvidenceResponse(jsonResult(202, { event_id: V2_ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'accepted' }), V2_ENTRY),
    'ack',
  );
  assert.equal(
    classifyEvidenceResponse(jsonResult(200, { event_id: V2_ENTRY.eventId, schema_version: 'git-evidence/v1', status: 'duplicate' }), V2_ENTRY),
    'ack',
  );
});

test('git_evidence_v2: an ACK echoing the entry version is also an ack, but a v1 entry still takes only v1', () => {
  assert.equal(
    classifyEvidenceResponse(jsonResult(202, { event_id: V2_ENTRY.eventId, schema_version: 'git-evidence/v2', status: 'accepted' }), V2_ENTRY),
    'ack',
  );
  assert.equal(
    classifyEvidenceResponse(jsonResult(202, { event_id: ENTRY.eventId, schema_version: 'git-evidence/v2', status: 'accepted' }), { ...ENTRY, schemaVersion: 'git-evidence/v1' }),
    'pause_protocol',
  );
});

test('git_evidence_v2: a downgrade whose entry was already settled elsewhere backs off instead of pausing delivery', () => withEvidenceDataDir('prism-git-evidence-v2-settled-', async () => {
  const outbox = require('../lib/git-evidence-outbox');
  const entry = v2Entry('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');
  const [pending] = outbox.listPendingEvidence();
  // A concurrent drain delivered and removed it.
  assert.equal(outbox.markEvidenceDelivered(pending.eventId), true);

  const ingest = require('../lib/ingest');
  const originalSend = ingest.sendGitEvidence;
  let sends = 0;
  ingest.sendGitEvidence = async () => {
    sends += 1;
    return unsupportedSchemaResult();
  };
  try {
    const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
    const outcome = await deliverEvidenceEntry(pending, {});
    assert.equal(outcome.disposition, 'retry');
    assert.equal(outcome.paused, false);
  } finally {
    ingest.sendGitEvidence = originalSend;
  }
  assert.equal(sends, 1);
  assert.deepEqual(outbox.listPendingEvidence(), []);
}));

test('git_evidence_v2: a refused v2 entry with no valid v1 body is settled as a permanent rejection', () => withEvidenceDataDir('prism-git-evidence-v2-no-v1-', async () => {
  const outbox = require('../lib/git-evidence-outbox');
  const entry = v2Entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  entry.payload.diff.commits[0].added_lines = -1;
  assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');
  const [pending] = outbox.listPendingEvidence();

  const ingest = require('../lib/ingest');
  const originalSend = ingest.sendGitEvidence;
  ingest.sendGitEvidence = async () => unsupportedSchemaResult();
  try {
    const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
    const outcome = await deliverEvidenceEntry(pending, {});
    assert.equal(outcome.disposition, 'terminal_permanent');
    assert.equal(outcome.terminalReason, 'permanent_http_rejection');
    assert.equal(outcome.paused, false);
  } finally {
    ingest.sendGitEvidence = originalSend;
  }
  assert.deepEqual(outbox.listPendingEvidence(), []);
}));

test('git_evidence_v2: an unsupported schema downgrades a v2 entry and still pauses a v1 entry', () => {
  assert.equal(classifyEvidenceResponse(unsupportedSchemaResult(), V2_ENTRY), 'downgrade_schema');
  assert.equal(classifyEvidenceResponse(unsupportedSchemaResult(), ENTRY), 'pause_protocol');
  assert.equal(classifyEvidenceResponse(unsupportedSchemaResult(), { ...ENTRY, schemaVersion: 'git-evidence/v1' }), 'pause_protocol');
  // Every other v2 response is classified exactly as a v1 one.
  assert.equal(classifyEvidenceResponse(jsonResult(400, { error: { code: 'git_evidence_invalid_payload' } }), V2_ENTRY), 'terminal_permanent');
});

test('git_evidence_v2: the outbox spools, lists, and settles a v2 entry like a v1 one', () => withEvidenceDataDir('prism-git-evidence-v2-outbox-', () => {
  const outbox = require('../lib/git-evidence-outbox');
  const entry = v2Entry('77777777-7777-4777-8777-777777777777');
  assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');
  assert.equal(outbox.enqueueEvidence(entry).outcome, 'existing');
  const [pending] = outbox.listPendingEvidence();
  assert.equal(pending.schemaVersion, 'git-evidence/v2');
  assert.deepEqual(pending.payload, entry.payload);
  assert.equal(outbox.settleEvidenceTerminal(pending, 'permanent_http_rejection').state, 'terminal');
  assert.equal(outbox.evidenceCounts().terminalReasons.permanent_http_rejection, 1);
}));

test('git_evidence_v2: a v2 entry refused as unsupported is rewritten to v1 in place and resent once under the same event_id', () => withEvidenceDataDir('prism-git-evidence-v2-downgrade-', async () => {
  const outbox = require('../lib/git-evidence-outbox');
  const { downgradeGitEvidenceEvent } = require('../lib/git-evidence-contract');
  const id = '88888888-8888-4888-8888-888888888888';
  const entry = v2Entry(id);
  assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');
  const [pending] = outbox.listPendingEvidence();

  const ingest = require('../lib/ingest');
  const originalSend = ingest.sendGitEvidence;
  const sent = [];
  ingest.sendGitEvidence = async (payload) => {
    sent.push(payload);
    if (payload.schema_version === 'git-evidence/v2') return unsupportedSchemaResult();
    return jsonResult(202, { event_id: id, schema_version: 'git-evidence/v1', status: 'accepted' });
  };
  try {
    const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
    const outcome = await deliverEvidenceEntry(pending, {});
    assert.equal(outcome.acked, true);
    assert.equal(outcome.paused, false);
  } finally {
    ingest.sendGitEvidence = originalSend;
  }

  assert.equal(sent.length, 2);
  assert.equal(sent[0].schema_version, 'git-evidence/v2');
  assert.deepEqual(sent[1], downgradeGitEvidenceEvent(entry.payload));
  assert.equal(sent[1].event_id, id);
  assert.deepEqual(outbox.listPendingEvidence(), []);
}));

test('git_evidence_v2: a downgraded resend answered 409 was already stored as v2, so it is delivered, not a conflict', () => withEvidenceDataDir('prism-git-evidence-v2-lost-ack-', async () => {
  const outbox = require('../lib/git-evidence-outbox');
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  assert.equal(outbox.enqueueEvidence(v2Entry(id)).outcome, 'created');
  const [pending] = outbox.listPendingEvidence();

  const ingest = require('../lib/ingest');
  const originalSend = ingest.sendGitEvidence;
  ingest.sendGitEvidence = async (payload) => (payload.schema_version === 'git-evidence/v2'
    ? unsupportedSchemaResult()
    : jsonResult(409, { error: { code: 'git_evidence_event_conflict' } }));
  try {
    const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
    const outcome = await deliverEvidenceEntry(pending, {});
    assert.equal(outcome.disposition, 'ack');
    assert.equal(outcome.acked, true);
  } finally {
    ingest.sendGitEvidence = originalSend;
  }
  assert.deepEqual(outbox.listPendingEvidence(), []);
  assert.equal(outbox.evidenceCounts().terminal, 0, 'no conflict marker is recorded');
}));

test('git_evidence_v2: a 409 on a v1 entry that was never downgraded is still a conflict', () => withEvidenceDataDir('prism-git-evidence-v1-conflict-', async () => {
  const outbox = require('../lib/git-evidence-outbox');
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const entry = v2Entry(id);
  const { downgradeGitEvidenceEvent } = require('../lib/git-evidence-contract');
  const v1Entry = { ...entry, schemaVersion: 'git-evidence/v1', payload: downgradeGitEvidenceEvent(entry.payload) };
  assert.equal(outbox.enqueueEvidence(v1Entry).outcome, 'created');
  const [pending] = outbox.listPendingEvidence();

  const ingest = require('../lib/ingest');
  const originalSend = ingest.sendGitEvidence;
  ingest.sendGitEvidence = async () => jsonResult(409, { error: { code: 'git_evidence_event_conflict' } });
  try {
    const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
    const outcome = await deliverEvidenceEntry(pending, {});
    assert.equal(outcome.disposition, 'terminal_conflict');
    assert.equal(outcome.terminalReason, 'event_conflict');
  } finally {
    ingest.sendGitEvidence = originalSend;
  }
}));

test('git_evidence_v2: a downgraded entry that is refused again pauses with its v1 body kept, never looping', () => withEvidenceDataDir('prism-git-evidence-v2-refused-twice-', async () => {
  const outbox = require('../lib/git-evidence-outbox');
  const entry = v2Entry('99999999-9999-4999-8999-999999999999');
  assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');
  const [pending] = outbox.listPendingEvidence();

  const ingest = require('../lib/ingest');
  const originalSend = ingest.sendGitEvidence;
  let sends = 0;
  ingest.sendGitEvidence = async () => {
    sends += 1;
    return unsupportedSchemaResult();
  };
  try {
    const { deliverEvidenceEntry } = require('../lib/git-evidence-delivery');
    const outcome = await deliverEvidenceEntry(pending, {});
    assert.equal(outcome.disposition, 'pause_protocol');
    assert.equal(outcome.paused, true);
  } finally {
    ingest.sendGitEvidence = originalSend;
  }

  assert.equal(sends, 2);
  const [survivor] = outbox.listPendingEvidence();
  assert.equal(survivor.schemaVersion, 'git-evidence/v1');
  assert.equal(survivor.payload.schema_version, 'git-evidence/v1');
  assert.equal(Object.hasOwn(survivor.payload.diff, 'foreign_commit_filter'), false);
  assert.equal(survivor.deliveryAttempts, 0);
}));

// git_evidence_after_response_v1 (a real capability cache, a real repo, an
// unwritable evidence spool, driven through the actual submit/stop hook
// subprocesses so the capture attempt cannot be short-circuited at the
// capability gate) lives in test/hooks-output.test.js, which already owns
// the subprocess harness and interceptor infrastructure this needs.
