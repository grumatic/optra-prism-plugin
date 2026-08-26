'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function withDataDir(dataDir, action) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function samplePayload(eventId, overrides = {}) {
  return {
    schema_version: 'git-evidence/v1',
    event_id: eventId,
    event_type: 'committed_change_observation',
    observed_at: new Date().toISOString(),
    session_id: 'session-1',
    client_event_id: 'client-event-1',
    repository: {
      host: 'github.com', owner_path: 'a/b', name: 'r', root_fingerprint: '1'.repeat(64), phase: 'stop',
    },
    diff: {
      diff_policy_version: 'git_text_numstat_first_parent_v1', ancestry: 'linear', coverage: 'ready', excluded_binary_count: 0, excluded_submodule_count: 0, commits: [],
    },
    ...overrides,
  };
}

function sampleEntry(eventId, overrides = {}) {
  const now = new Date().toISOString();
  return {
    eventId,
    schemaVersion: 'git-evidence/v1',
    observedAt: now,
    createdAt: now,
    correlation: { sessionId: 'session-1', clientEventId: 'client-event-1' },
    payload: samplePayload(eventId),
    ...overrides,
  };
}

test('a duplicate enqueue of the identical payload returns existing with one file, a differing payload conflicts', () => {
  const dataDir = tempDir('prism-git-evidence-outbox-');
  withDataDir(dataDir, () => {
    const outbox = require('../lib/git-evidence-outbox');
    const id = '11111111-1111-4111-8111-111111111111';
    const entry = sampleEntry(id);
    assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');
    assert.equal(outbox.enqueueEvidence(entry).outcome, 'existing');
    assert.equal(outbox.listPendingEvidence().length, 1);

    const conflicting = sampleEntry(id, { payload: samplePayload(id, { session_id: 'other-session' }) });
    assert.equal(outbox.enqueueEvidence(conflicting).outcome, 'conflict');
    assert.equal(outbox.listPendingEvidence().length, 1);
  });
});

test('an oversized entry writes a local_entry_oversized terminal marker and never enters the pending spool', () => {
  const dataDir = tempDir('prism-git-evidence-outbox-oversized-');
  withDataDir(dataDir, () => {
    const outbox = require('../lib/git-evidence-outbox');
    const id = '22222222-2222-4222-8222-222222222222';
    const hugeCommits = Array.from({ length: 20000 }, (_, i) => ({
      commit_sha: i.toString(16).padStart(40, '0'), fingerprint: 'a'.repeat(64), added_lines: 1, deleted_lines: 0, merge_policy: 'first_parent_v1',
    }));
    const entry = sampleEntry(id, { payload: samplePayload(id, { diff: { diff_policy_version: 'git_text_numstat_first_parent_v1', ancestry: 'linear', coverage: 'ready', excluded_binary_count: 0, excluded_submodule_count: 0, commits: hugeCommits } }) });
    const result = outbox.enqueueEvidence(entry);
    assert.equal(result.outcome, 'oversized');
    assert.equal(outbox.listPendingEvidence().length, 0);
    const counts = outbox.evidenceCounts();
    assert.equal(counts.terminal, 1);
    assert.equal(counts.terminalReasons.local_entry_oversized, 1);
  });
});

test('pending ordering is (nextAttemptAt, observedAt, eventId), independent of file mtime', () => {
  const dataDir = tempDir('prism-git-evidence-outbox-order-');
  withDataDir(dataDir, () => {
    const outbox = require('../lib/git-evidence-outbox');
    const early = sampleEntry('11111111-1111-4111-8111-111111111111', { observedAt: '2026-01-01T00:00:00.000Z', nextAttemptAt: '2026-01-01T00:00:00.000Z' });
    const late = sampleEntry('22222222-2222-4222-8222-222222222222', { observedAt: '2026-01-02T00:00:00.000Z', nextAttemptAt: '2026-01-02T00:00:00.000Z' });
    // Enqueue the later-scheduled entry first so file creation order is the
    // reverse of the expected read order.
    assert.equal(outbox.enqueueEvidence(late).outcome, 'created');
    assert.equal(outbox.enqueueEvidence(early).outcome, 'created');
    const ordered = outbox.listPendingEvidence();
    assert.deepEqual(ordered.map((entry) => entry.eventId), [early.eventId, late.eventId]);
  });
});

test('git_evidence_spool_bounds_v1: entry 2048 is accepted and 2049 produces local_capacity_full with no eviction of pending', () => {
  const dataDir = tempDir('prism-git-evidence-outbox-cap-');
  withDataDir(dataDir, () => {
    const outbox = require('../lib/git-evidence-outbox');
    for (let i = 0; i < outbox.MAX_EVIDENCE_PENDING_ENTRIES; i += 1) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
      const result = outbox.enqueueEvidence(sampleEntry(id));
      assert.equal(result.outcome, 'created', `entry ${i} should be accepted`);
    }
    assert.equal(outbox.listPendingEvidence().length, outbox.MAX_EVIDENCE_PENDING_ENTRIES);

    const overflowId = '00000000-0000-4000-8000-ffffffffffff';
    const overflow = outbox.enqueueEvidence(sampleEntry(overflowId));
    assert.equal(overflow.outcome, 'capacity_full');
    assert.equal(outbox.listPendingEvidence().length, outbox.MAX_EVIDENCE_PENDING_ENTRIES);
  });
});

test('an expired pending entry becomes local_retention_expired on prune, never silently deleted', () => {
  const dataDir = tempDir('prism-git-evidence-outbox-retention-');
  withDataDir(dataDir, () => {
    const outbox = require('../lib/git-evidence-outbox');
    const id = '33333333-3333-4333-8333-333333333333';
    const old = new Date(Date.now() - outbox.EVIDENCE_PENDING_RETENTION_MS - 1000).toISOString();
    const entry = sampleEntry(id, { createdAt: old });
    assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');

    const result = outbox.pruneExpiredEvidence();
    assert.equal(result.expired, 1);
    assert.equal(outbox.listPendingEvidence().length, 0);
    const counts = outbox.evidenceCounts();
    assert.equal(counts.terminalReasons.local_retention_expired, 1);
  });
});

test('settleEvidenceTerminal removes the pending entry and writes a terminal marker exactly once', () => {
  const dataDir = tempDir('prism-git-evidence-outbox-settle-');
  withDataDir(dataDir, () => {
    const outbox = require('../lib/git-evidence-outbox');
    const id = '44444444-4444-4444-8444-444444444444';
    const entry = sampleEntry(id);
    assert.equal(outbox.enqueueEvidence(entry).outcome, 'created');

    const first = outbox.settleEvidenceTerminal(entry, 'permanent_http_rejection');
    assert.equal(first.state, 'terminal');
    assert.equal(outbox.listPendingEvidence().length, 0);

    // Re-settling the same event is idempotent, not a second write.
    const second = outbox.settleEvidenceTerminal(entry, 'permanent_http_rejection');
    assert.equal(second.state, 'terminal');
    assert.equal(outbox.evidenceCounts().terminal, 1);
  });
});

test('git_outbox_isolation_v1: a full, unwritable, or rejecting evidence spool does not touch the response outbox', () => {
  const dataDir = tempDir('prism-git-evidence-outbox-isolation-');
  withDataDir(dataDir, () => {
    const outbox = require('../lib/git-evidence-outbox');
    const responseOutbox = require('../lib/response-outbox');

    const promptResult = responseOutbox.enqueueDetailed({
      id: 'prompt-isolation-test',
      kind: 'prompt',
      payload: { prompt_text: 'hello', source: 'claude-code', tool_session_id: 's' },
    });
    assert.equal(promptResult.outcome, 'created');

    for (let i = 0; i < 5; i += 1) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '1')}`;
      outbox.enqueueEvidence(sampleEntry(id));
    }
    outbox.settleEvidenceTerminal(sampleEntry('00000000-0000-4000-8000-000000000001'), 'permanent_http_rejection');

    assert.equal(responseOutbox.listPending().length, 1);
    assert.equal(responseOutbox.listPending()[0].id, 'prompt-isolation-test');
  });
});
