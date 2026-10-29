'use strict';

require('./helpers/isolate-claude-env');

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
  downgradeGitEvidenceEvent,
  validateGitEvidenceEvent,
  GIT_EVIDENCE_SCHEMA_VERSION,
  GIT_EVIDENCE_SCHEMA_VERSION_V2,
  GIT_EVIDENCE_SCHEMA_VERSIONS,
  GIT_EVIDENCE_FOREIGN_COMMIT_FILTERS,
  GIT_EVIDENCE_AUTHOR_FILTERS,
  MAX_GIT_EVIDENCE_PARENT_COUNT,
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

  assert.equal(validateGitEvidenceEvent({ ...base(), schema_version: 'git-evidence/v3' }), 'unknown_schema_version');
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

// ─── git-evidence/v2 ───

function builderInput(overrides = {}) {
  return {
    eventId: deriveEvidenceEventId('response-op-1'),
    observedAt: '2026-07-29T05:06:07.123Z',
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
      foreignCommitFilter: 'applied',
      commits: [
        {
          commitSha: '4'.repeat(40), parentSha: '2'.repeat(40), parentCount: 1, authorFilter: 'own', fingerprint: '5'.repeat(64), addedLines: 42, deletedLines: 7,
        },
        {
          commitSha: '3'.repeat(40), parentSha: '4'.repeat(40), parentCount: 2, authorFilter: 'foreign', fingerprint: '6'.repeat(64), addedLines: 3, deletedLines: 0,
        },
      ],
    },
    ...overrides,
  };
}

function withoutV2Inputs(input) {
  return {
    ...input,
    diff: {
      ...input.diff,
      foreignCommitFilter: undefined,
      commits: input.diff.commits.map(({ parentCount: _parentCount, authorFilter: _authorFilter, ...commit }) => commit),
    },
  };
}

function sampleV2Event() {
  const event = sampleGitEvidenceEvent();
  delete event.verification;
  event.schema_version = GIT_EVIDENCE_SCHEMA_VERSION_V2;
  event.diff.foreign_commit_filter = 'applied';
  event.diff.commits = event.diff.commits.map((commit, index) => ({
    ...commit, author_filter: index === 0 ? 'own' : 'foreign', parent_count: 1,
  }));
  return event;
}

test('git_evidence_v2: the version list mirrors the server, oldest first', () => {
  assert.deepEqual(GIT_EVIDENCE_SCHEMA_VERSIONS, ['git-evidence/v1', 'git-evidence/v2']);
  assert.equal(GIT_EVIDENCE_SCHEMA_VERSION_V2, 'git-evidence/v2');
});

test('git_evidence_v2: a v1 build ignores every v2 input and is byte-identical to a build without them', () => {
  const input = builderInput();
  const withV2Inputs = buildGitEvidenceEvent(input);
  const plain = buildGitEvidenceEvent(withoutV2Inputs(input));
  const explicitV1 = buildGitEvidenceEvent({ ...input, schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION });
  assert.ok(plain);
  assert.equal(JSON.stringify(withV2Inputs), JSON.stringify(plain));
  assert.equal(JSON.stringify(explicitV1), JSON.stringify(plain));
  assert.equal(plain.schema_version, GIT_EVIDENCE_SCHEMA_VERSION);
  assert.equal(Object.hasOwn(plain.diff, 'foreign_commit_filter'), false);
  for (const commit of plain.diff.commits) {
    assert.equal(Object.hasOwn(commit, 'author_filter'), false);
    assert.equal(Object.hasOwn(commit, 'parent_count'), false);
  }
});

test('git_evidence_v2: an applied build carries the filter, every verdict, and every parent count', () => {
  const event = buildGitEvidenceEvent({ ...builderInput(), schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2 });
  assert.ok(event);
  assert.equal(event.schema_version, GIT_EVIDENCE_SCHEMA_VERSION_V2);
  assert.equal(event.diff.foreign_commit_filter, 'applied');
  assert.deepEqual(event.diff.commits.map((commit) => commit.author_filter), ['own', 'foreign']);
  assert.deepEqual(event.diff.commits.map((commit) => commit.parent_count), [1, 2]);
  assert.equal(validateGitEvidenceEvent(event), null);
});

test('git_evidence_v2: an unavailable build keeps parent counts and carries no verdict', () => {
  const input = builderInput();
  input.diff.foreignCommitFilter = 'unavailable';
  const event = buildGitEvidenceEvent({ ...input, schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2 });
  assert.ok(event);
  assert.equal(event.diff.foreign_commit_filter, 'unavailable');
  for (const commit of event.diff.commits) assert.equal(Object.hasOwn(commit, 'author_filter'), false);
  assert.deepEqual(event.diff.commits.map((commit) => commit.parent_count), [1, 2]);
  assert.equal(validateGitEvidenceEvent(event), null);
});

test('git_evidence_v2: a diff with no filter input reports unavailable (no verdict was made)', () => {
  const event = buildGitEvidenceEvent({
    ...builderInput(),
    schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2,
    diff: {
      ancestry: 'unknown', coverage: 'unavailable', reason: 'baseline_missing', excludedBinaryCount: 0, excludedSubmoduleCount: 0, commits: [],
    },
  });
  assert.ok(event);
  assert.equal(event.diff.foreign_commit_filter, 'unavailable');
});

test('git_evidence_v2: a root commit (no parent) carries no parent_count', () => {
  const input = builderInput();
  input.diff.commits = [{
    commitSha: '4'.repeat(40), authorFilter: 'own', fingerprint: '5'.repeat(64), addedLines: 1, deletedLines: 0,
  }];
  const event = buildGitEvidenceEvent({ ...input, schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2 });
  assert.ok(event);
  assert.equal(Object.hasOwn(event.diff.commits[0], 'parent_sha'), false);
  assert.equal(Object.hasOwn(event.diff.commits[0], 'parent_count'), false);
});

test('git_evidence_v2: a commit with a parent but no parent count, or an applied commit with no verdict, builds nothing', () => {
  const missingCount = builderInput();
  delete missingCount.diff.commits[0].parentCount;
  assert.equal(buildGitEvidenceEvent({ ...missingCount, schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2 }), null);

  const missingVerdict = builderInput();
  delete missingVerdict.diff.commits[1].authorFilter;
  assert.equal(buildGitEvidenceEvent({ ...missingVerdict, schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2 }), null);
});

test('git_evidence_v2: the budget replacement keeps the filter a v2 diff requires', () => {
  const event = buildGitEvidenceEvent({ ...builderInput(), schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2 });
  const replacement = buildUnavailableGitEvidenceEvent(event, 'payload_budget_exceeded');
  assert.equal(replacement.diff.foreign_commit_filter, 'applied');
  assert.deepEqual(replacement.diff.commits, []);
  assert.equal(validateGitEvidenceEvent(replacement), null);

  const v1 = buildUnavailableGitEvidenceEvent(buildGitEvidenceEvent(builderInput()), 'payload_budget_exceeded');
  assert.equal(Object.hasOwn(v1.diff, 'foreign_commit_filter'), false);
  assert.equal(validateGitEvidenceEvent(v1), null);
});

test('git_evidence_v2: the validator applies the server v2 rules', () => {
  assert.equal(validateGitEvidenceEvent(sampleV2Event()), null);

  const missingFilter = sampleV2Event();
  delete missingFilter.diff.foreign_commit_filter;
  assert.equal(validateGitEvidenceEvent(missingFilter), 'missing_foreign_commit_filter');

  const badFilter = sampleV2Event();
  badFilter.diff.foreign_commit_filter = 'partial';
  assert.equal(validateGitEvidenceEvent(badFilter), 'invalid_foreign_commit_filter');

  const v1WithFilter = sampleGitEvidenceEvent();
  delete v1WithFilter.verification;
  v1WithFilter.diff.foreign_commit_filter = 'applied';
  assert.equal(validateGitEvidenceEvent(v1WithFilter), 'unexpected_v2_field');

  for (const field of [{ author_filter: 'own' }, { parent_count: 1 }]) {
    const v1WithCommitField = sampleGitEvidenceEvent();
    delete v1WithCommitField.verification;
    Object.assign(v1WithCommitField.diff.commits[1], field);
    assert.equal(validateGitEvidenceEvent(v1WithCommitField), 'unexpected_v2_field');
  }

  const missingVerdict = sampleV2Event();
  delete missingVerdict.diff.commits[1].author_filter;
  assert.equal(validateGitEvidenceEvent(missingVerdict), 'author_filter_mismatch');

  const unexpectedVerdict = sampleV2Event();
  unexpectedVerdict.diff.foreign_commit_filter = 'unavailable';
  assert.equal(validateGitEvidenceEvent(unexpectedVerdict), 'author_filter_mismatch');

  const badVerdict = sampleV2Event();
  badVerdict.diff.commits[0].author_filter = 'mine';
  assert.equal(validateGitEvidenceEvent(badVerdict), 'invalid_author_filter');

  const missingCount = sampleV2Event();
  delete missingCount.diff.commits[0].parent_count;
  assert.equal(validateGitEvidenceEvent(missingCount), 'missing_parent_count');

  for (const count of [0, MAX_GIT_EVIDENCE_PARENT_COUNT + 1, 1.5, '1']) {
    const badCount = sampleV2Event();
    badCount.diff.commits[0].parent_count = count;
    assert.equal(validateGitEvidenceEvent(badCount), 'invalid_parent_count', String(count));
  }
  const maxCount = sampleV2Event();
  maxCount.diff.commits[0].parent_count = MAX_GIT_EVIDENCE_PARENT_COUNT;
  assert.equal(validateGitEvidenceEvent(maxCount), null);

  const countWithoutParent = sampleV2Event();
  delete countWithoutParent.diff.commits[0].parent_sha;
  assert.equal(validateGitEvidenceEvent(countWithoutParent), 'invalid_parent_count');
});

test('git_evidence_v2: v2 rules run before the submodule, commit-count, and coverage checks, as on the server', () => {
  const diffRule = sampleV2Event();
  delete diffRule.diff.foreign_commit_filter;
  diffRule.diff.excluded_submodule_count = -1;
  diffRule.diff.coverage = 'unavailable';
  assert.equal(validateGitEvidenceEvent(diffRule), 'missing_foreign_commit_filter');

  const commitRule = sampleV2Event();
  delete commitRule.diff.commits[0].parent_count;
  commitRule.diff.reason = 'baseline_missing';
  assert.equal(validateGitEvidenceEvent(commitRule), 'missing_parent_count');
});

test('git_evidence_v2: v2 field names and values pass the disallowed-field scan', () => {
  for (const name of ['foreign_commit_filter', 'author_filter', 'parent_count']) {
    assert.equal(GIT_EVIDENCE_DISALLOWED_FIELD_NAMES.includes(name), false);
  }
  assert.deepEqual(GIT_EVIDENCE_FOREIGN_COMMIT_FILTERS, ['applied', 'unavailable']);
  assert.deepEqual(GIT_EVIDENCE_AUTHOR_FILTERS, ['own', 'foreign']);
});

test('git_evidence_v2: downgrading strips exactly the v2 fields and yields the v1 build of the same observation', () => {
  const input = builderInput();
  const v2 = buildGitEvidenceEvent({ ...input, schemaVersion: GIT_EVIDENCE_SCHEMA_VERSION_V2 });
  const downgraded = downgradeGitEvidenceEvent(v2);
  assert.ok(downgraded);
  assert.equal(validateGitEvidenceEvent(downgraded), null);
  assert.equal(canonicalJson(downgraded), canonicalJson(buildGitEvidenceEvent(withoutV2Inputs(input))));
  assert.equal(v2.schema_version, GIT_EVIDENCE_SCHEMA_VERSION_V2, 'the input event is not mutated');
  assert.equal(v2.diff.foreign_commit_filter, 'applied');

  assert.equal(downgradeGitEvidenceEvent(buildGitEvidenceEvent(input)), null, 'a v1 event is not downgraded');
  assert.equal(downgradeGitEvidenceEvent(null), null);
});
