'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const contract = require('../lib/git-evidence-contract');

const {
  canonicalJson,
  deriveEvidenceEventId,
  commitFingerprint,
  buildGitEvidenceEvent,
  buildUnavailableGitEvidenceEvent,
  validateGitEvidenceEvent,
  GIT_EVIDENCE_SCHEMA_VERSION,
  GIT_EVIDENCE_DIFF_POLICY_VERSION,
  GIT_EVIDENCE_MERGE_POLICY,
  GIT_EVIDENCE_EVENT_TYPES,
  GIT_EVIDENCE_PHASES,
  GIT_EVIDENCE_ANCESTRY,
  GIT_EVIDENCE_DIFF_COVERAGE,
  GIT_EVIDENCE_DIFF_REASONS,
  GIT_EVIDENCE_ERROR_CODES,
  GIT_EVIDENCE_DISALLOWED_FIELD_NAMES,
  MAX_GIT_EVIDENCE_COMMITS,
  MAX_GIT_EVIDENCE_REQUEST_BYTES,
} = contract;

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'git-evidence-v1.json'), 'utf8');

// Mirrors the Rust `testing::sample_git_evidence_event()` fixture. This is
// a maximal shape (carries `verification`, `sequence`, `sub_session_id`,
// `server_prompt_id`) — deliberately not producible by buildGitEvidenceEvent,
// which never emits `verification`. It exists only to pin the golden bytes
// and exercise the validator against the server's own reference shape.
function sampleGitEvidenceEvent() {
  return {
    schema_version: GIT_EVIDENCE_SCHEMA_VERSION,
    event_id: '00000000-0000-4000-8000-0000000000e1',
    event_type: 'committed_change_observation',
    observed_at: '2026-07-29T05:06:07.123456789Z',
    session_id: 'session-1',
    client_event_id: 'client-event-1',
    host_prompt_id: 'host-prompt-1',
    server_prompt_id: '00000000-0000-4000-8000-0000000000c1',
    response_operation_id: 'response-op-1',
    sub_session_id: '00000000-0000-4000-8000-0000000000e2',
    sequence: 1,
    repository: {
      host: 'github.com',
      owner_path: 'example-org/example-group',
      name: 'example-repo',
      root_fingerprint: '1'.repeat(68).slice(0, 64),
      branch: 'main',
      head: '3'.repeat(40),
      dirty: false,
      phase: 'stop',
    },
    diff: {
      base_head: '2'.repeat(40),
      head: '3'.repeat(40),
      diff_policy_version: GIT_EVIDENCE_DIFF_POLICY_VERSION,
      ancestry: 'linear',
      coverage: 'ready',
      excluded_binary_count: 1,
      excluded_submodule_count: 0,
      commits: [
        {
          commit_sha: '4'.repeat(40),
          parent_sha: '2'.repeat(40),
          fingerprint: '5'.repeat(68).slice(0, 64),
          added_lines: 42,
          deleted_lines: 7,
          merge_policy: GIT_EVIDENCE_MERGE_POLICY,
        },
        {
          commit_sha: '3'.repeat(40),
          parent_sha: '4'.repeat(40),
          fingerprint: '6'.repeat(68).slice(0, 64),
          added_lines: 3,
          deleted_lines: 0,
          merge_policy: GIT_EVIDENCE_MERGE_POLICY,
        },
      ],
    },
    verification: {
      kind: 'test',
      status: 'passed',
      started_at: '2026-07-29T05:06:07.123456789Z',
      ended_at: '2026-07-29T05:07:07.123456789Z',
      head: '3'.repeat(40),
    },
  };
}

test('git_evidence_body_budget_v1: golden bytes match the shared fixture', () => {
  assert.equal(`${canonicalJson(sampleGitEvidenceEvent())}\n`, fixture);
});

test('every enum value used by the sample is present in the closed exported enums', () => {
  const sample = sampleGitEvidenceEvent();
  assert.ok(GIT_EVIDENCE_EVENT_TYPES.includes(sample.event_type));
  assert.ok(GIT_EVIDENCE_PHASES.includes(sample.repository.phase));
  assert.ok(GIT_EVIDENCE_ANCESTRY.includes(sample.diff.ancestry));
  assert.ok(GIT_EVIDENCE_DIFF_COVERAGE.includes(sample.diff.coverage));
});

test('the fixture validates against the Plugin validator (rule parity with the server)', () => {
  assert.equal(validateGitEvidenceEvent(sampleGitEvidenceEvent()), null);
});

test('buildGitEvidenceEvent never emits verification, sequence, or sub_session_id (narrower than the maximal fixture)', () => {
  const event = buildGitEvidenceEvent({
    eventId: deriveEvidenceEventId('response-op-1'),
    observedAt: new Date().toISOString(),
    sessionId: 'session-1',
    clientEventId: 'client-event-1',
    hostPromptId: 'host-prompt-1',
    repository: {
      host: 'github.com',
      ownerPath: 'example-org/example-group',
      name: 'example-repo',
      rootFingerprint: '1'.repeat(64),
      branch: 'main',
      head: '3'.repeat(40),
      dirty: false,
      phase: 'stop',
    },
    diff: {
      baseHead: '2'.repeat(40),
      head: '3'.repeat(40),
      ancestry: 'linear',
      coverage: 'ready',
      excludedBinaryCount: 0,
      excludedSubmoduleCount: 0,
      commits: [],
    },
  });
  assert.ok(event);
  assert.equal(Object.hasOwn(event, 'verification'), false);
  assert.equal(Object.hasOwn(event, 'sequence'), false);
  assert.equal(Object.hasOwn(event, 'sub_session_id'), false);
});

test('deriveEvidenceEventId is deterministic, non-nil, and v4-shaped', () => {
  const first = deriveEvidenceEventId('response-op-1');
  const second = deriveEvidenceEventId('response-op-1');
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, '00000000-0000-0000-0000-000000000000');
  assert.notEqual(deriveEvidenceEventId('response-op-2'), first);
});

test('same_commit_multi_observer_v1: commitFingerprint is unkeyed — stable across different install keys', () => {
  const inputs = {
    commitSha: '4'.repeat(40), parentSha: '2'.repeat(40), addedLines: 42, deletedLines: 7,
  };
  // commitFingerprint takes no key argument at all, unlike rootFingerprint —
  // this test documents that guarantee rather than simulating two installs.
  assert.equal(commitFingerprint(inputs), commitFingerprint({ ...inputs }));
});

test('commitFingerprint differs when any input differs', () => {
  const base = {
    commitSha: '4'.repeat(40), parentSha: '2'.repeat(40), addedLines: 42, deletedLines: 7,
  };
  const baseline = commitFingerprint(base);
  assert.notEqual(commitFingerprint({ ...base, commitSha: '5'.repeat(40) }), baseline);
  assert.notEqual(commitFingerprint({ ...base, parentSha: '6'.repeat(40) }), baseline);
  assert.notEqual(commitFingerprint({ ...base, addedLines: 43 }), baseline);
  assert.notEqual(commitFingerprint({ ...base, deletedLines: 8 }), baseline);
});

test('git_evidence_body_budget_v1: 512 commits validate, 513 do not fit the closed budget', () => {
  const makeCommits = (count) => Array.from({ length: count }, (_, i) => ({
    commit_sha: i.toString(16).padStart(40, '0'),
    fingerprint: 'a'.repeat(64),
    added_lines: 1,
    deleted_lines: 0,
    merge_policy: GIT_EVIDENCE_MERGE_POLICY,
  }));
  const base = sampleGitEvidenceEvent();
  delete base.verification;
  delete base.sequence;
  delete base.sub_session_id;

  const ok = { ...base, diff: { ...base.diff, commits: makeCommits(MAX_GIT_EVIDENCE_COMMITS) } };
  assert.equal(validateGitEvidenceEvent(ok), null);
  assert.ok(Buffer.byteLength(canonicalJson(ok), 'utf8') < MAX_GIT_EVIDENCE_REQUEST_BYTES);

  const tooMany = { ...base, diff: { ...base.diff, commits: makeCommits(MAX_GIT_EVIDENCE_COMMITS + 1) } };
  assert.notEqual(validateGitEvidenceEvent(tooMany), null);

  const unavailable = buildUnavailableGitEvidenceEvent(tooMany, 'commit_limit_exceeded');
  assert.equal(validateGitEvidenceEvent(unavailable), null);
  assert.equal(unavailable.diff.coverage, 'unavailable');
  assert.equal(unavailable.diff.commits.length, 0);
});

test('uncommitted_excluded_v1: no builder input path can produce a disallowed member name or value', () => {
  const built = [
    sampleGitEvidenceEvent(),
    buildGitEvidenceEvent({
      eventId: deriveEvidenceEventId('op-1'),
      observedAt: new Date().toISOString(),
      sessionId: 's',
      clientEventId: 'c',
      repository: {
        host: 'github.com', ownerPath: 'a/b', name: 'r', rootFingerprint: '1'.repeat(64), phase: 'stop',
      },
      diff: {
        ancestry: 'linear', coverage: 'ready', excludedBinaryCount: 0, excludedSubmoduleCount: 0, commits: [],
      },
    }),
  ];
  for (const event of built) {
    const serialized = canonicalJson(event);
    for (const disallowed of GIT_EVIDENCE_DISALLOWED_FIELD_NAMES) {
      assert.ok(
        !new RegExp(`"${disallowed}"\\s*:`).test(serialized),
        `unexpected disallowed member ${disallowed}`,
      );
    }
    assert.ok(!serialized.includes('working_tree_snapshot'));
  }
});

test('plugin_contract_v1: a remote URL carrying userinfo/port/query/fragment sanitizes cleanly', () => {
  const { sanitizeRemoteUrl } = contract;
  const sanitized = sanitizeRemoteUrl('https://user:pw@github.com:443/example-org/example-repo.git?x=1#frag');
  assert.deepEqual(sanitized, {
    host: 'github.com', ownerPath: 'example-org', owner: 'example-org', repo: 'example-repo',
  });
});

test('plugin_contract_v1: an absolute path, a relative path, and a file: URL yield no repository identity', () => {
  const { sanitizeRemoteUrl } = contract;
  assert.equal(sanitizeRemoteUrl('/abs/path/repo'), null);
  assert.equal(sanitizeRemoteUrl('./relative/repo'), null);
  assert.equal(sanitizeRemoteUrl('file:///abs/path/repo'), null);
});

test('validateGitEvidenceEvent rejects each rule in the table', () => {
  const base = () => {
    const event = sampleGitEvidenceEvent();
    delete event.verification;
    return event;
  };

  assert.notEqual(validateGitEvidenceEvent({ ...base(), schema_version: 'git-evidence/v2' }), null);
  assert.notEqual(validateGitEvidenceEvent({ ...base(), event_id: '00000000-0000-0000-0000-000000000000' }), null);
  assert.notEqual(validateGitEvidenceEvent({ ...base(), session_id: '' }), null);
  assert.notEqual(validateGitEvidenceEvent({ ...base(), client_event_id: '' }), null);
  assert.notEqual(validateGitEvidenceEvent({ ...base(), host_prompt_id: '' }), null);
  assert.notEqual(validateGitEvidenceEvent({ ...base(), response_operation_id: '' }), null);

  const badHost = base();
  badHost.repository = { ...badHost.repository, host: 'Github.com' };
  assert.notEqual(validateGitEvidenceEvent(badHost), null);

  const badOwnerPath = base();
  badOwnerPath.repository = { ...badOwnerPath.repository, owner_path: '/leading' };
  assert.notEqual(validateGitEvidenceEvent(badOwnerPath), null);

  const badName = base();
  badName.repository = { ...badName.repository, name: 'owner/name' };
  assert.notEqual(validateGitEvidenceEvent(badName), null);

  const badFingerprint = base();
  badFingerprint.repository = { ...badFingerprint.repository, root_fingerprint: '1'.repeat(63) };
  assert.notEqual(validateGitEvidenceEvent(badFingerprint), null);

  const badBranch = base();
  badBranch.repository = { ...badBranch.repository, branch: 'x'.repeat(1025) };
  assert.notEqual(validateGitEvidenceEvent(badBranch), null);

  const badRepoHead = base();
  badRepoHead.repository = { ...badRepoHead.repository, head: '1'.repeat(39) };
  assert.notEqual(validateGitEvidenceEvent(badRepoHead), null);

  const badPolicy = base();
  badPolicy.diff = { ...badPolicy.diff, diff_policy_version: 'other' };
  assert.notEqual(validateGitEvidenceEvent(badPolicy), null);

  const badBaseHead = base();
  badBaseHead.diff = { ...badBaseHead.diff, base_head: 'zz' };
  assert.notEqual(validateGitEvidenceEvent(badBaseHead), null);

  const tooManyCommits = base();
  tooManyCommits.diff = {
    ...tooManyCommits.diff,
    commits: Array.from({ length: MAX_GIT_EVIDENCE_COMMITS + 1 }, () => tooManyCommits.diff.commits[0]),
  };
  assert.notEqual(validateGitEvidenceEvent(tooManyCommits), null);

  const readyWithReason = base();
  readyWithReason.diff = { ...readyWithReason.diff, reason: 'baseline_missing' };
  assert.notEqual(validateGitEvidenceEvent(readyWithReason), null);

  const partialNoReason = base();
  partialNoReason.diff = { ...partialNoReason.diff, coverage: 'partial', reason: undefined };
  assert.notEqual(validateGitEvidenceEvent(partialNoReason), null);

  const unavailableWithCommits = base();
  unavailableWithCommits.diff = { ...unavailableWithCommits.diff, coverage: 'unavailable', reason: 'non_ancestor' };
  assert.notEqual(validateGitEvidenceEvent(unavailableWithCommits), null);

  const missingDiff = base();
  delete missingDiff.diff;
  assert.notEqual(validateGitEvidenceEvent(missingDiff), null);

  assert.ok(GIT_EVIDENCE_DIFF_REASONS.length > 0);
  assert.ok(GIT_EVIDENCE_ERROR_CODES.length > 0);
});
