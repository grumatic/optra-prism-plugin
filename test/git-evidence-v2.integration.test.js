'use strict';

require('./helpers/isolate-claude-env');

// Opt-in end-to-end check of git-evidence/v2 against a locally running Prism
// stack (ingest + worker + PostgreSQL). Skipped unless all of these are set:
//
//   PRISM_IT_INGEST_URL    local ingest, e.g. http://127.0.0.1:9002, started
//                          with GIT_EVIDENCE_V2_ADVERTISED=true
//   PRISM_IT_API_KEY       a developer API key that local ingest accepts
//   PRISM_IT_DATABASE_URL  the local database the worker writes to; only
//                          read here (SELECT), through `psql`
//
//   PRISM_IT_INGEST_URL=... PRISM_IT_API_KEY=... PRISM_IT_DATABASE_URL=... \
//     node --test test/git-evidence-v2.integration.test.js
//
// With PRISM_IT_SERVER=v1-only the stack is a server that predates v2 (or
// has it switched off): the v2 checks are skipped, and the plugin is instead
// shown to behave as before against it, including resending as v1 an entry
// built as v2 that such a server refuses.
//
// Real UserPromptSubmit and Stop hooks run in a throwaway HOME, plugin data
// directory, and repository; Git's global and system config are isolated so
// the developer's own author email never decides a verdict.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SUBMIT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'submit-handler.js');
const STOP_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'stop-handler.js');
const GIT_CONTEXT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'git-context-handler.js');
const INGEST_URL = process.env.PRISM_IT_INGEST_URL;
const API_KEY = process.env.PRISM_IT_API_KEY;
const DATABASE_URL = process.env.PRISM_IT_DATABASE_URL;
const SKIP = (INGEST_URL && API_KEY && DATABASE_URL)
  ? false
  : 'set PRISM_IT_INGEST_URL, PRISM_IT_API_KEY and PRISM_IT_DATABASE_URL to run against a local stack';
const V1_ONLY = process.env.PRISM_IT_SERVER === 'v1-only';
const SKIP_V2 = SKIP || (V1_ONLY && 'the server under test predates git-evidence/v2');
const SKIP_V1_ONLY = SKIP || (!V1_ONLY && 'set PRISM_IT_SERVER=v1-only for a server without git-evidence/v2');
const PERSIST_TIMEOUT_MS = 30000;
const DELIVERY_TIMEOUT_MS = 15000;

const ME = 'me@example.test';
const TEAMMATE = 'teammate@example.test';
const tempDirs = [];
let home;
let dataDir;
let hookEnv;
const previousEnv = {};

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// The modules that read HOME or CLAUDE_PLUGIN_DATA at load are reloaded so
// this process acts as the same install the hook subprocesses use.
function freshModules() {
  for (const name of ['../lib/env', '../lib/config', '../lib/git-evidence-capability', '../lib/git-evidence-delivery']) {
    delete require.cache[require.resolve(name)];
  }
}

before(() => {
  if (SKIP) return;
  home = tempDir('prism-it-home-');
  dataDir = path.join(home, '.claude', 'plugins', 'data', 'prism-optra-prism');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config.json'), JSON.stringify({
    apiKey: API_KEY, ingest_url: INGEST_URL, show_realtime_summary: false,
  }));
  const globalConfig = path.join(home, 'isolated.gitconfig');
  fs.writeFileSync(globalConfig, '');
  const overrides = {
    HOME: home, CLAUDE_PLUGIN_DATA: dataDir, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_EMAIL: undefined, EMAIL: undefined,
  };
  for (const [key, value] of Object.entries(overrides)) {
    previousEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  hookEnv = { ...process.env };
  freshModules();
});

after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  freshModules();
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function makeRepo({ userEmail = ME } = {}) {
  const repo = tempDir('prism-it-repo-');
  const git = (args) => execFileSync('git', args, { cwd: repo, env: hookEnv, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Prism IT']);
  // Without an email, refuse Git's host-name guess so none is determined.
  if (userEmail) git(['config', 'user.email', userEmail]);
  else git(['config', 'user.useConfigOnly', 'true']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  git(['add', 'tracked.txt']);
  git(['-c', `user.email=${ME}`, 'commit', '-q', '-m', 'initial']);
  // A unique repository per run, so no commit is shared with a past run.
  git(['remote', 'add', 'origin', `https://github.com/prism-it/git-evidence-v2-${crypto.randomUUID()}.git`]);
  const commitAs = (email, file, line) => {
    fs.appendFileSync(path.join(repo, file), `${line}\n`);
    git(['add', file]);
    git(['-c', `user.email=${email}`, 'commit', '-q', '-m', line]);
    return git(['rev-parse', 'HEAD']);
  };
  return { repo, git, commitAs };
}

function runHook(script, input) {
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT, encoding: 'utf8', input: JSON.stringify(input), env: hookEnv, timeout: 30000,
  });
  assert.equal(result.status, 0, `${path.basename(script)} failed: ${result.stderr}`);
  return result;
}

// One real turn: UserPromptSubmit, the commits made during the turn, Stop.
// `duringTurn` receives the turn's ids, and Stop runs in the `stopCwd` its
// result names, or in `repo`.
function runTurn(repo, duringTurn) {
  const sessionId = crypto.randomUUID();
  const promptId = crypto.randomUUID();
  const transcript = path.join(home, `transcript-${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '');
  runHook(SUBMIT_HANDLER, {
    cwd: repo, hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: 'git evidence v2 integration', prompt_id: promptId, session_id: sessionId, transcript_path: transcript,
  });
  const commits = duringTurn({ sessionId, promptId, transcript });
  const stopCwd = (commits && commits.stopCwd) || repo;
  const reply = 'git evidence v2 integration reply';
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'user', prompt_id: promptId, message: { role: 'user', content: 'request' } }),
    JSON.stringify({
      type: 'assistant',
      uuid: `assistant-${sessionId}`,
      message: {
        role: 'assistant', stop_reason: 'end_turn', content: reply, model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
      },
    }),
    '',
  ].join('\n'));
  runHook(STOP_HANDLER, {
    cwd: stopCwd, hook_event_name: 'Stop', last_assistant_message: reply, permission_mode: 'default', prompt_id: promptId, session_id: sessionId, stop_hook_active: false, transcript_path: transcript,
  });
  return { sessionId, commits };
}

function pendingFor(sessionId) {
  const { listPendingEvidence } = require('../lib/git-evidence-outbox');
  return listPendingEvidence().filter((entry) => entry.correlation.sessionId === sessionId);
}

// Stop sends at most one entry within 500ms and may already have delivered
// this one; drain whatever is left, failing with the disposition when the
// service pauses or rejects it.
async function deliver(sessionId) {
  // A closed gate means Stop captured nothing: fail now, not after the
  // persistence wait.
  const { readCapabilityCache, capabilityAllowsEvidence } = require('../lib/git-evidence-capability');
  const snapshot = readCapabilityCache();
  assert.ok(capabilityAllowsEvidence(snapshot), `capability gate closed (state ${snapshot && snapshot.state}): check the first test's failure`);
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  while (pendingFor(sessionId).length > 0) {
    assert.ok(Date.now() < deadline, 'evidence was not delivered in time');
    const { drainEvidence } = require('../lib/git-evidence-delivery');
    const outcomes = await drainEvidence({ prioritizeIds: pendingFor(sessionId).map((pending) => pending.eventId) });
    for (const outcome of outcomes) {
      assert.ok(['ack', 'retry'].includes(outcome.disposition), `delivery ${outcome.disposition}: HTTP ${outcome.result && outcome.result.status} ${outcome.result && outcome.result.body}`);
    }
    if (pendingFor(sessionId).length > 0) await sleep(500);
  }
}

function anyFileContains(dir, text) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true }).some((item) => {
    const itemPath = path.join(dir, item.name);
    return item.isDirectory() ? anyFileContains(itemPath, text) : fs.readFileSync(itemPath, 'latin1').includes(text);
  });
}

function select(sql) {
  return execFileSync('psql', [DATABASE_URL, '-X', '-q', '-tA', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((line) => line.split('|'));
}

// What the worker stored for this session's observation, commits in ordinal order.
async function storedObservation(sessionId) {
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const deadline = Date.now() + PERSIST_TIMEOUT_MS;
  for (;;) {
    const rows = select(`
      SELECT o.schema_version, coalesce(o.foreign_commit_filter, 'NULL'),
             coalesce(rc.commit_sha, ''), coalesce(oc.author_filter, 'NULL'), coalesce(rc.parent_count::text, 'NULL')
        FROM prism.git_evidence_observations o
        LEFT JOIN prism.git_evidence_observation_changes oc ON oc.observation_id = o.id
        LEFT JOIN prism.repository_changes rc ON rc.id = oc.repository_change_id
       WHERE o.session_id = '${sessionId}'
       ORDER BY oc.evidence_ordinal`);
    if (rows.length > 0) {
      return {
        schemaVersion: rows[0][0],
        foreignCommitFilter: rows[0][1],
        commits: rows.filter((row) => row[2]).map(([, , commitSha, authorFilter, parentCount]) => ({ commitSha, authorFilter, parentCount })),
      };
    }
    assert.ok(Date.now() < deadline, `no observation stored for session ${sessionId} within ${PERSIST_TIMEOUT_MS}ms (is the worker running?)`);
    await sleep(1000);
  }
}

function seedVersions(versions) {
  const { readCapabilityCache } = require('../lib/git-evidence-capability');
  const { bindingDigest } = require('../lib/binding');
  const cached = readCapabilityCache();
  fs.writeFileSync(
    path.join(dataDir, 'runtime', `git-evidence-capability-${bindingDigest(API_KEY, INGEST_URL)}.json`),
    JSON.stringify({ ...cached, versions }),
    { mode: 0o600 },
  );
}

test('a v1-only ingest advertises exactly git-evidence/v1, so the plugin builds v1', { skip: SKIP_V1_ONLY }, async () => {
  const { refreshCapability, negotiatedEvidenceVersion } = require('../lib/git-evidence-capability');
  const snapshot = await refreshCapability({ force: true });
  assert.equal(snapshot.state, 'supported', `capability state ${snapshot.state}: check PRISM_IT_INGEST_URL and PRISM_IT_API_KEY`);
  assert.deepEqual(snapshot.versions, ['git-evidence/v1']);
  assert.equal(negotiatedEvidenceVersion(snapshot), 'git-evidence/v1');
});

test('against a v1-only ingest, a turn with teammate and merge commits is stored as v1 always was', { skip: SKIP_V1_ONLY }, async () => {
  const { repo, git, commitAs } = makeRepo();
  const { sessionId, commits } = runTurn(repo, () => {
    const own = commitAs(ME, 'tracked.txt', 'mine');
    const teammate = commitAs(TEAMMATE, 'tracked.txt', 'theirs');
    git(['checkout', '-q', '-b', 'side']);
    commitAs(TEAMMATE, 'side.txt', 'side work');
    git(['checkout', '-q', 'main']);
    git(['-c', `user.email=${ME}`, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side']);
    return { own, teammate, merge: git(['rev-parse', 'HEAD']) };
  });

  await deliver(sessionId);
  const stored = await storedObservation(sessionId);
  assert.equal(stored.schemaVersion, 'git-evidence/v1');
  assert.equal(stored.foreignCommitFilter, 'NULL');
  assert.deepEqual(stored.commits, [
    { commitSha: commits.own, authorFilter: 'NULL', parentCount: 'NULL' },
    { commitSha: commits.teammate, authorFilter: 'NULL', parentCount: 'NULL' },
    { commitSha: commits.merge, authorFilter: 'NULL', parentCount: 'NULL' },
  ]);
});

test('a v2 entry a v1-only ingest refuses is resent as v1, stored, and v2 is withdrawn', { skip: SKIP_V1_ONLY }, async () => {
  // The cache still lists v2, as after an ingest rolled back past it.
  seedVersions(['git-evidence/v1', 'git-evidence/v2']);
  const { repo, commitAs } = makeRepo();
  const { sessionId, commits } = runTurn(repo, () => ({
    own: commitAs(ME, 'tracked.txt', 'mine'),
    teammate: commitAs(TEAMMATE, 'tracked.txt', 'theirs'),
  }));

  await deliver(sessionId);
  const stored = await storedObservation(sessionId);
  assert.equal(stored.schemaVersion, 'git-evidence/v1');
  assert.equal(stored.foreignCommitFilter, 'NULL');
  assert.deepEqual(stored.commits, [
    { commitSha: commits.own, authorFilter: 'NULL', parentCount: 'NULL' },
    { commitSha: commits.teammate, authorFilter: 'NULL', parentCount: 'NULL' },
  ]);
  const { readCapabilityCache } = require('../lib/git-evidence-capability');
  const cache = readCapabilityCache();
  assert.equal(cache.state, 'supported');
  assert.deepEqual(cache.versions, ['git-evidence/v1']);
});

test('local ingest advertises git-evidence/v2', { skip: SKIP_V2 }, async () => {
  const { refreshCapability, negotiatedEvidenceVersion } = require('../lib/git-evidence-capability');
  const snapshot = await refreshCapability({ force: true });
  assert.equal(snapshot.state, 'supported', `capability state ${snapshot.state}: check PRISM_IT_INGEST_URL and PRISM_IT_API_KEY`);
  assert.equal(
    negotiatedEvidenceVersion(snapshot),
    'git-evidence/v2',
    `advertised ${JSON.stringify(snapshot.versions)}: start ingest with GIT_EVIDENCE_V2_ADVERTISED=true`,
  );
});

test('a v2 turn stores own/foreign verdicts and parent counts', { skip: SKIP_V2 }, async () => {
  const { repo, git, commitAs } = makeRepo();
  const { sessionId, commits } = runTurn(repo, () => {
    const own = commitAs(ME, 'tracked.txt', 'mine');
    // A teammate's commit fast-forwarded in, as `git pull` would.
    const teammate = commitAs(TEAMMATE, 'tracked.txt', 'theirs');
    git(['checkout', '-q', '-b', 'side']);
    commitAs(TEAMMATE, 'side.txt', 'side work');
    git(['checkout', '-q', 'main']);
    git(['-c', `user.email=${ME}`, 'merge', '-q', '--no-ff', 'side', '-m', 'merge side']);
    return { own, teammate, merge: git(['rev-parse', 'HEAD']) };
  });

  await deliver(sessionId);
  assert.equal(anyFileContains(dataDir, 'example.test'), false, 'no email anywhere the plugin wrote');

  const stored = await storedObservation(sessionId);
  assert.equal(stored.schemaVersion, 'git-evidence/v2');
  assert.equal(stored.foreignCommitFilter, 'applied');
  assert.deepEqual(stored.commits, [
    { commitSha: commits.own, authorFilter: 'own', parentCount: '1' },
    { commitSha: commits.teammate, authorFilter: 'foreign', parentCount: '1' },
    { commitSha: commits.merge, authorFilter: 'own', parentCount: '2' },
  ]);
});

test('when Git cannot determine an author email a v2 turn stores unavailable and no verdict', { skip: SKIP_V2 }, async () => {
  const { repo, commitAs } = makeRepo({ userEmail: null });
  const { sessionId, commits } = runTurn(repo, () => ({ own: commitAs(ME, 'tracked.txt', 'mine') }));

  await deliver(sessionId);
  const stored = await storedObservation(sessionId);
  assert.equal(stored.foreignCommitFilter, 'unavailable');
  assert.deepEqual(stored.commits, [{ commitSha: commits.own, authorFilter: 'NULL', parentCount: '1' }]);
});

test('a v1 turn (an older plugin, or v2 not yet advertised) is still stored as before', { skip: SKIP }, async () => {
  seedVersions(['git-evidence/v1']);
  const { repo, commitAs } = makeRepo();
  const { sessionId, commits } = runTurn(repo, () => ({ own: commitAs(ME, 'tracked.txt', 'mine') }));

  await deliver(sessionId);
  const stored = await storedObservation(sessionId);
  assert.equal(stored.schemaVersion, 'git-evidence/v1');
  assert.equal(stored.foreignCommitFilter, 'NULL');
  assert.deepEqual(stored.commits, [{ commitSha: commits.own, authorFilter: 'NULL', parentCount: 'NULL' }]);
});

// Turns that move during the turn: the worker stores the commits made after
// the move, with the baseline and branch of the directory the turn ended in.
function storedBaseline(sessionId) {
  const [row] = select(`
    SELECT evidence_coverage, coalesce(evidence_reason, ''), coalesce(baseline_head, ''), coalesce(repository_branch, '')
      FROM prism.git_evidence_observations WHERE session_id = '${sessionId}'`);
  return { coverage: row[0], reason: row[1], baselineHead: row[2], branch: row[3] };
}

// Every observation stored for the session, keyed by branch, once `count` of
// them are there: a turn that left a worktree stores one per worktree.
async function storedByBranch(sessionId, count) {
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  const deadline = Date.now() + PERSIST_TIMEOUT_MS;
  for (;;) {
    const rows = select(`
      SELECT o.event_id, o.schema_version, coalesce(o.repository_branch, ''), o.evidence_coverage,
             coalesce(o.baseline_head, ''), coalesce(rc.commit_sha, '')
        FROM prism.git_evidence_observations o
        LEFT JOIN prism.git_evidence_observation_changes oc ON oc.observation_id = o.id
        LEFT JOIN prism.repository_changes rc ON rc.id = oc.repository_change_id
       WHERE o.session_id = '${sessionId}'
       ORDER BY o.event_id, oc.evidence_ordinal`);
    const byBranch = {};
    for (const [eventId, schemaVersion, branch, coverage, baselineHead, commitSha] of rows) {
      byBranch[branch] = byBranch[branch] || { eventId, schemaVersion, coverage, baselineHead, commits: [] };
      if (commitSha) byBranch[branch].commits.push(commitSha);
    }
    if (Object.keys(byBranch).length >= count) return byBranch;
    assert.ok(Date.now() < deadline, `${Object.keys(byBranch).length} of ${count} observations stored for ${sessionId}`);
    await sleep(1000);
  }
}

function commitIn(cwd, file, line) {
  const git = (args) => execFileSync('git', args, { cwd, env: hookEnv, encoding: 'utf8' }).trim();
  fs.appendFileSync(path.join(cwd, file), `${line}\n`);
  git(['add', file]);
  git(['-c', `user.email=${ME}`, 'commit', '-q', '-m', line]);
  return git(['rev-parse', 'HEAD']);
}

test('a turn that enters a worktree and ends there stores the worktree commits on its branch', { skip: SKIP }, async () => {
  const { repo, git } = makeRepo();
  const base = git(['rev-parse', 'HEAD']);
  // Clear of the submit's second, so the base commit is unambiguously older.
  await sleep(2000);
  const { sessionId, commits } = runTurn(repo, ({ sessionId: id, promptId, transcript }) => {
    const worktree = path.join(repo, '.claude', 'worktrees', 'it-feature');
    git(['worktree', 'add', '-q', '-b', 'worktree-it-feature', worktree]);
    const real = fs.realpathSync.native(worktree);
    runHook(GIT_CONTEXT_HANDLER, {
      hook_event_name: 'PostToolUse', session_id: id, prompt_id: promptId, cwd: real, transcript_path: transcript,
      tool_name: 'EnterWorktree', tool_input: { name: 'it-feature' }, tool_response: { worktreePath: real, worktreeBranch: 'worktree-it-feature' },
    });
    return { own: commitIn(real, 'tracked.txt', 'in the worktree'), stopCwd: real };
  });

  await deliver(sessionId);
  const stored = await storedObservation(sessionId);
  assert.deepEqual(stored.commits.map((commit) => commit.commitSha), [commits.own]);
  assert.deepEqual(storedBaseline(sessionId), {
    coverage: 'ready', reason: '', baselineHead: base, branch: 'worktree-it-feature',
  });
});

test('a worktree created in the turn from a commit made in it stores the worktree commits, and the checkout it left its own', { skip: SKIP }, async () => {
  const { repo, git } = makeRepo();
  const base = git(['rev-parse', 'HEAD']);
  // No pause after the repository's last commit: the worktree's base is a
  // commit newer than the turn's start, as after merging a pull request.
  const { sessionId, commits } = runTurn(repo, ({ sessionId: id, promptId, transcript }) => {
    const merged = commitIn(repo, 'tracked.txt', 'merged in the turn');
    const worktree = path.join(repo, '.claude', 'worktrees', 'it-fresh');
    git(['worktree', 'add', '-q', '-b', 'worktree-it-fresh', worktree]);
    const real = fs.realpathSync.native(worktree);
    runHook(GIT_CONTEXT_HANDLER, {
      hook_event_name: 'PostToolUse', session_id: id, prompt_id: promptId, cwd: real, transcript_path: transcript,
      tool_name: 'EnterWorktree', tool_input: { name: 'it-fresh' }, tool_response: { worktreePath: real, worktreeBranch: 'worktree-it-fresh' },
    });
    return { merged, own: commitIn(real, 'tracked.txt', 'in the fresh worktree'), stopCwd: real };
  });

  await deliver(sessionId);
  const stored = await storedByBranch(sessionId, 2);
  assert.equal(stored['worktree-it-fresh'].coverage, 'ready');
  assert.equal(stored['worktree-it-fresh'].baselineHead, commits.merged);
  assert.deepEqual(stored['worktree-it-fresh'].commits, [commits.own]);
  // The commit made in the checkout the turn left, under its own event.
  assert.equal(stored.main.baselineHead, base);
  assert.deepEqual(stored.main.commits, [commits.merged]);
  assert.notEqual(stored.main.eventId, stored['worktree-it-fresh'].eventId);
});

test('a turn that commits in two worktrees of one repository stores both, one observation each', { skip: SKIP }, async () => {
  const { repo, git } = makeRepo();
  const worktree = (name) => {
    const dir = path.join(repo, '.claude', 'worktrees', name);
    git(['worktree', 'add', '-q', '-b', `worktree-${name}`, dir]);
    return fs.realpathSync.native(dir);
  };
  const left = worktree('it-left');
  const stop = worktree('it-stop');
  const leftBase = git(['rev-parse', 'HEAD']);
  await sleep(2000);
  const { sessionId, commits } = runTurn(left, ({ sessionId: id, promptId, transcript }) => {
    const inLeft = commitIn(left, 'tracked.txt', 'in the first worktree');
    runHook(GIT_CONTEXT_HANDLER, {
      hook_event_name: 'PostToolUse', session_id: id, prompt_id: promptId, cwd: stop, transcript_path: transcript,
      tool_name: 'EnterWorktree', tool_input: { name: 'it-stop' }, tool_response: { worktreePath: stop, worktreeBranch: 'worktree-it-stop' },
    });
    return { inLeft, inStop: commitIn(stop, 'tracked.txt', 'in the second worktree'), stopCwd: stop };
  });

  await deliver(sessionId);
  const stored = await storedByBranch(sessionId, 2);
  assert.deepEqual(stored['worktree-it-stop'].commits, [commits.inStop]);
  assert.deepEqual(stored['worktree-it-left'].commits, [commits.inLeft]);
  assert.equal(stored['worktree-it-left'].baselineHead, leftBase);
  assert.equal(stored['worktree-it-left'].schemaVersion, stored['worktree-it-stop'].schemaVersion);
  if (V1_ONLY) assert.equal(stored['worktree-it-left'].schemaVersion, 'git-evidence/v1');
});

test('a turn captured on an hour-old capability cache is delivered once Stop refreshes it', { skip: SKIP }, async () => {
  const { readCapabilityCache } = require('../lib/git-evidence-capability');
  const { bindingDigest } = require('../lib/binding');
  const old = new Date(Date.now() - 2 * 3600000).toISOString();
  fs.writeFileSync(
    path.join(dataDir, 'runtime', `git-evidence-capability-${bindingDigest(API_KEY, INGEST_URL)}.json`),
    JSON.stringify({ ...readCapabilityCache(), last_success_at: old, checked_at: old }),
  );
  const { repo, git } = makeRepo();
  const base = git(['rev-parse', 'HEAD']);
  await sleep(2000);
  const { sessionId, commits } = runTurn(repo, () => ({ own: commitIn(repo, 'tracked.txt', 'on an old cache') }));

  await deliver(sessionId);
  const stored = await storedObservation(sessionId);
  assert.deepEqual(stored.commits.map((commit) => commit.commitSha), [commits.own]);
  assert.deepEqual(storedBaseline(sessionId), {
    coverage: 'ready', reason: '', baselineHead: base, branch: 'main',
  });
});

test('a turn that ends in a subdirectory stores its commits', { skip: SKIP }, async () => {
  const { repo, git, commitAs } = makeRepo();
  const base = git(['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(repo, 'sub'));
  const subdirectory = fs.realpathSync.native(path.join(repo, 'sub'));
  const { sessionId, commits } = runTurn(repo, ({ sessionId: id, promptId, transcript }) => {
    const own = commitAs(ME, 'tracked.txt', 'at the root');
    runHook(GIT_CONTEXT_HANDLER, {
      hook_event_name: 'CwdChanged', session_id: id, prompt_id: promptId, cwd: subdirectory,
      old_cwd: fs.realpathSync.native(repo), new_cwd: subdirectory, transcript_path: transcript,
    });
    return { own, stopCwd: subdirectory };
  });

  await deliver(sessionId);
  const stored = await storedObservation(sessionId);
  assert.deepEqual(stored.commits.map((commit) => commit.commitSha), [commits.own]);
  assert.deepEqual(storedBaseline(sessionId), {
    coverage: 'ready', reason: '', baselineHead: base, branch: 'main',
  });
});
