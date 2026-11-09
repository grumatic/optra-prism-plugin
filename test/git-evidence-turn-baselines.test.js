'use strict';

require('./helpers/isolate-claude-env');

// Real UserPromptSubmit, CwdChanged, PostToolUse(EnterWorktree), and Stop
// hooks run against throwaway repositories and worktrees, with every HTTP
// request answered in-process: the prompt is captured, and git evidence stays
// pending in the local outbox, where each test reads what Stop built.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');
const { CURRENT_HOST_VERSION, pinClaudeHostVersion } = require('./helpers/claude-host');

pinClaudeHostVersion(CURRENT_HOST_VERSION);

const { bindingDigest } = require('../lib/binding');
const {
  deriveEvidenceEventId,
  validateGitEvidenceEvent,
  GIT_EVIDENCE_ENDPOINT_PATH,
  GIT_EVIDENCE_SCHEMA_VERSION,
  GIT_EVIDENCE_SCHEMA_VERSION_V2,
} = require('../lib/git-evidence-contract');
const { CAPABILITY_CACHE_SCHEMA } = require('../lib/git-evidence-capability');

const ROOT = path.resolve(__dirname, '..');
const SUBMIT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'submit-handler.js');
const GIT_CONTEXT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'git-context-handler.js');
const STOP_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'stop-handler.js');
const API_KEY = 'prism_turn_baselines';
const INGEST_URL = 'http://127.0.0.1:12345';
const SERVER_PROMPT_ID = '5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f';
// Reflog entries carry whole seconds. Setup happens well before the prompt
// and the turn's own commits well after it, so only the test written for it
// puts a commit in the second a turn was submitted.
const BEFORE_TURN = () => `@${Math.floor(Date.now() / 1000) - 3600} +0000`;
const DURING_TURN = () => `@${Math.floor(Date.now() / 1000) + 5} +0000`;
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeInterceptor(home) {
  const file = path.join(home, 'ingest-interceptor.js');
  fs.writeFileSync(file, [
    "const events = require('node:events');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  const request = new events.EventEmitter();',
    '  request.write = () => {};',
    '  request.destroy = () => {};',
    '  request.setTimeout = () => request;',
    '  request.end = () => {',
    "    const pathname = typeof url === 'string' ? new URL(url).pathname : url.pathname;",
    "    const response = Object.assign(new events.EventEmitter(), { headers: { 'content-type': 'application/json' } });",
    // A test can let the capability refresh succeed; otherwise it fails as
    // a transient error, like every other request but the prompt pair.
    "    const configOk = pathname === '/v1/plugin/config' && process.env.PRISM_TEST_CAPABILITY === 'supported';",
    "    response.statusCode = pathname === '/v1/prompts' ? 201 : pathname === '/v1/prompts/response' ? 202 : configOk ? 200 : 503;",
    '    callback(response);',
    `    if (pathname === '/v1/prompts') response.emit('data', Buffer.from('{"id":"${SERVER_PROMPT_ID}"}'));`,
    "    if (configOk) response.emit('data', Buffer.from(JSON.stringify({ contracts: { git_evidence: { endpoint: '/v1/git-evidence', versions: ['git-evidence/v1', 'git-evidence/v2'] } } })));",
    "    response.emit('end');",
    '  };',
    '  return request;',
    '};',
    '',
  ].join('\n'));
  return file;
}

// One plugin install: config, a capability cache that lets evidence be
// captured, and an isolated Git configuration shared by the hooks and by
// the Git commands each test runs itself.
function makeInstall() {
  const home = tempDir('prism-turn-baselines-home-');
  const dataDir = path.join(home, '.claude', 'plugins', 'data', 'prism-optra-prism');
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config.json'), JSON.stringify({
    apiKey: API_KEY, ingest_url: INGEST_URL, show_realtime_summary: false,
  }));
  const digest = bindingDigest(API_KEY, INGEST_URL);
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'runtime', `git-evidence-capability-${digest}.json`), JSON.stringify({
    schema_version: CAPABILITY_CACHE_SCHEMA,
    binding_digest: digest,
    checked_at: nowIso,
    last_success_at: nowIso,
    state: 'supported',
    endpoint: GIT_EVIDENCE_ENDPOINT_PATH,
    versions: [GIT_EVIDENCE_SCHEMA_VERSION, GIT_EVIDENCE_SCHEMA_VERSION_V2],
  }));
  const gitConfig = path.join(home, 'isolated.gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\temail = me@example.test\n\tname = Prism Test\n[commit]\n\tgpgsign = false\n');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const hookEnv = {
    ...gitEnv,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_PLUGIN_ROOT: ROOT,
    NODE_OPTIONS: `--require=${writeInterceptor(home)}`,
  };
  return { home, dataDir, gitEnv, hookEnv };
}

// `reflog: false` makes a repository that never keeps a HEAD reflog, in the
// main checkout or in any worktree added to it.
function makeRepo(install, { reflog = true } = {}) {
  const repo = tempDir('prism-turn-baselines-repo-');
  const git = gitIn(install, repo);
  git(['init', '-q', '-b', 'main']);
  if (!reflog) git(['config', 'core.logAllRefUpdates', 'false']);
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', 'a.txt'), 'initial\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  git(['remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
  return repo;
}

function gitIn(install, cwd) {
  return (args, when = BEFORE_TURN) => {
    const date = when();
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...install.gitEnv, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    }).trim();
  };
}

function addWorktree(install, repo, name, when = BEFORE_TURN) {
  const worktree = path.join(repo, '.claude', 'worktrees', name);
  gitIn(install, repo)(['worktree', 'add', '-q', '-b', `worktree-${name}`, worktree], when);
  return fs.realpathSync.native(worktree);
}

// A commit made during the turn, in `cwd`.
function commitDuringTurn(install, cwd, file, when = DURING_TURN) {
  const git = gitIn(install, cwd);
  fs.writeFileSync(path.join(cwd, file), `${file}\n`);
  git(['add', file], when);
  git(['commit', '-q', '-m', file], when);
  return git(['rev-parse', 'HEAD'], when);
}

function sessionDir(install, sessionId) {
  return path.join(install.dataDir, 'runtime', 'sessions', crypto.createHash('sha256').update(sessionId).digest('hex'));
}

// Rewrites the newest turn-baselines record in place, as a state the hooks
// cannot reach on demand (a fallback head, an emitted leave).
function rewriteTurnBaselines(install, sessionId, change) {
  const dir = sessionDir(install, sessionId);
  const order = (name) => name.match(/\.g(\d+)\.f(\d+)\.json$/).slice(1).map(Number);
  const [newest] = fs.readdirSync(dir)
    .filter((name) => /^git-turn-baselines\.g\d+\.f\d+\.json$/.test(name))
    .sort((left, right) => {
      const [lg, lf] = order(left);
      const [rg, rf] = order(right);
      return rf - lf || rg - lg;
    });
  const file = path.join(dir, newest);
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8')))));
}

function runHook(install, script, input, env = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT, encoding: 'utf8', input: JSON.stringify(input), env: { ...install.hookEnv, ...env }, timeout: 20000,
  });
  assert.equal(result.status, 0, `${path.basename(script)} failed: ${result.stderr}`);
  return result;
}

function startTurn(install, cwd, env = {}) {
  const turn = {
    install,
    sessionId: `session-${crypto.randomUUID()}`,
    promptId: crypto.randomUUID(),
    transcript: path.join(install.home, `transcript-${crypto.randomUUID()}.jsonl`),
  };
  fs.writeFileSync(turn.transcript, '');
  runHook(install, SUBMIT_HANDLER, {
    hook_event_name: 'UserPromptSubmit', session_id: turn.sessionId, prompt_id: turn.promptId,
    cwd, prompt: 'turn baselines', transcript_path: turn.transcript, permission_mode: 'default',
  }, env);
  return turn;
}

// A service that takes no commit evidence: the capability cache is gone.
function disableEvidence(install) {
  fs.rmSync(path.join(install.dataDir, 'runtime', `git-evidence-capability-${bindingDigest(API_KEY, INGEST_URL)}.json`));
}

// Has Git itself record every command the hooks run (GIT_TRACE), with no
// wrapper process that could push a call past its deadline.
function gitCallLog(install, name = 'git-trace') {
  const log = path.join(install.home, name);
  const marker = 'trace: built-in: git ';
  return {
    env: { GIT_TRACE: log },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [])
      .filter((line) => line.includes(marker))
      .map((line) => line.slice(line.indexOf(marker) + marker.length).replace(/'/g, '')),
  };
}

function cwdChanged(turn, oldCwd, newCwd, extra = {}) {
  runHook(turn.install, GIT_CONTEXT_HANDLER, {
    hook_event_name: 'CwdChanged', session_id: turn.sessionId, prompt_id: turn.promptId,
    cwd: newCwd, old_cwd: oldCwd, new_cwd: newCwd, transcript_path: turn.transcript, ...extra,
  });
}

function enterWorktree(turn, worktree, extra = {}) {
  runHook(turn.install, GIT_CONTEXT_HANDLER, {
    hook_event_name: 'PostToolUse', session_id: turn.sessionId, prompt_id: turn.promptId,
    cwd: worktree, tool_name: 'EnterWorktree', tool_input: { name: path.basename(worktree) },
    tool_response: { worktreePath: worktree, worktreeBranch: `worktree-${path.basename(worktree)}` },
    tool_use_id: `tool-${crypto.randomUUID()}`, transcript_path: turn.transcript, ...extra,
  });
}

function stopTurn(turn, cwd, env = {}) {
  runHook(turn.install, STOP_HANDLER, {
    hook_event_name: 'Stop', session_id: turn.sessionId, prompt_id: turn.promptId, cwd,
    last_assistant_message: 'done', stop_hook_active: false, transcript_path: turn.transcript,
  }, env);
  return evidenceFor(turn);
}

function evidenceFor(turn) {
  const dir = path.join(turn.install.dataDir, 'runtime', 'git-evidence-outbox');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
    .filter((entry) => entry.correlation.sessionId === turn.sessionId);
}

function onlyEvent(turn, entries) {
  assert.equal(entries.length, 1, `expected one evidence entry for ${turn.sessionId}`);
  const event = entries[0].payload;
  assert.equal(validateGitEvidenceEvent(event), null);
  return { entry: entries[0], event };
}

function committedShas(event) {
  return event.diff.commits.map((commit) => commit.commit_sha);
}

function withDataDir(install, read) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = install.dataDir;
  try {
    return read(require('../lib/session'));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test('a turn without a directory change reports its commits under the unchanged event id', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const sha = commitDuringTurn(install, repo, 'b.txt');

  const { entry, event } = onlyEvent(turn, stopTurn(turn, repo));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
  const responseOperationId = crypto.createHash('sha256')
    .update(`${turn.sessionId}\n${entry.correlation.clientEventId}\n${turn.promptId}`)
    .digest('hex');
  assert.equal(entry.eventId, deriveEvidenceEventId(responseOperationId));
  assert.equal(event.repository.branch, 'main');
});

test('a turn that enters a worktree and ends there reports the worktree commits from its base commit', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'feature');
  enterWorktree(turn, worktree);
  const first = commitDuringTurn(install, worktree, 'one.txt');
  const second = commitDuringTurn(install, worktree, 'two.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [first, second]);
  assert.equal(event.repository.branch, 'worktree-feature');
});

test('without the EnterWorktree hook, the worktree reflog still supplies the baseline at Stop', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'unhooked');
  const sha = commitDuringTurn(install, worktree, 'one.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
  assert.equal(event.repository.branch, 'worktree-unhooked');
});

test('a commit made by the same Bash command that entered the worktree is kept', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'bash-cd');
  const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  // `cd <worktree> && git commit`: CwdChanged arrives only after the commit.
  const sameCommand = commitDuringTurn(install, worktree, 'one.txt');
  cwdChanged(turn, repo, worktree);
  const later = commitDuringTurn(install, worktree, 'two.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sameCommand, later]);
});

test('a turn that ends in a subdirectory of its own worktree keeps the prompt baseline', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const sha = commitDuringTurn(install, repo, 'b.txt');
  const subdirectory = path.join(repo, 'sub');
  cwdChanged(turn, repo, subdirectory);

  const { event } = onlyEvent(turn, stopTurn(turn, subdirectory));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
  const record = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.equal(record, null, 'Stop clears the per-turn record');
});

test('leaving and re-entering a worktree in one turn keeps every commit made there', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'revisit');
  enterWorktree(turn, worktree);
  const first = commitDuringTurn(install, worktree, 'one.txt');
  cwdChanged(turn, worktree, repo);
  cwdChanged(turn, repo, worktree);
  const second = commitDuringTurn(install, worktree, 'two.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [first, second]);
  const visits = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.equal(visits, null);
});

test('a worktree without a reflog takes its baseline from the EnterWorktree hook, and has none without it', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  // Worktrees created after this never get a HEAD reflog, and their commits
  // do not start one.
  gitIn(install, repo)(['config', 'core.logAllRefUpdates', 'false']);
  const hooked = addWorktree(install, repo, 'nolog-hooked');
  const unhooked = addWorktree(install, repo, 'nolog-unhooked');
  const base = gitIn(install, hooked)(['rev-parse', 'HEAD']);

  const withHook = startTurn(install, repo);
  enterWorktree(withHook, hooked);
  const sha = commitDuringTurn(install, hooked, 'one.txt');
  const hookedEvent = onlyEvent(withHook, stopTurn(withHook, hooked)).event;
  assert.equal(hookedEvent.diff.coverage, 'ready');
  assert.equal(hookedEvent.diff.base_head, base);
  assert.deepEqual(committedShas(hookedEvent), [sha]);

  const withoutHook = startTurn(install, repo);
  commitDuringTurn(install, unhooked, 'one.txt');
  const missing = onlyEvent(withoutHook, stopTurn(withoutHook, unhooked)).event;
  assert.equal(missing.diff.coverage, 'unavailable');
  assert.equal(missing.diff.reason, 'baseline_missing');
});

test('only the main conversation\'s own active turn records an entered worktree', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'foreign');
  const turn = startTurn(install, repo);
  const before = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.equal(before.currentRoot, repo);
  assert.equal(before.roots.length, 1);
  assert.equal(before.roots[0].source, 'prompt');

  enterWorktree(turn, worktree, { prompt_id: crypto.randomUUID() });
  enterWorktree(turn, worktree, { agent_id: 'subagent-1' });
  cwdChanged(turn, repo, worktree, { prompt_id: undefined });
  runHook(install, GIT_CONTEXT_HANDLER, {
    hook_event_name: 'PostToolUse', session_id: turn.sessionId, prompt_id: turn.promptId,
    cwd: worktree, tool_name: 'Bash', tool_input: { command: 'true' },
  });
  assert.deepEqual(withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId)), before);

  enterWorktree(turn, worktree);
  const after = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.equal(after.currentRoot, worktree);
  assert.deepEqual(after.roots.map((entry) => [entry.root, entry.source, entry.visit]), [
    [repo, 'prompt', 1],
    [worktree, 'enter_worktree', 1],
  ]);
});

test('a turn-baselines record with keys this version does not know is ignored', () => {
  const install = makeInstall();
  const sessionId = 'unknown-keys-session';
  const dir = path.join(
    install.dataDir, 'runtime', 'sessions', crypto.createHash('sha256').update(sessionId).digest('hex'),
  );
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    schemaVersion: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    generation: 1,
    baselinesVersion: 1,
    epoch: 1,
    clientEventId: 'client-event',
    submittedAt: new Date().toISOString(),
    promptRoot: '/repo',
    currentRoot: '/repo',
    roots: [],
  };
  fs.writeFileSync(path.join(dir, 'git-turn-baselines.g1.f1.json'), JSON.stringify(record));
  assert.deepEqual(withDataDir(install, (session) => session.readTurnBaselines(sessionId)), record);

  fs.writeFileSync(path.join(dir, 'git-turn-baselines.g1.f1.json'), JSON.stringify({ ...record, futureField: true }));
  assert.equal(withDataDir(install, (session) => session.readTurnBaselines(sessionId)), null);
});

test('Stop reads the reflog before a head the entry hook stored, which may postdate the turn start', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'fallback');
  const sha = commitDuringTurn(install, worktree, 'one.txt');
  enterWorktree(turn, worktree);
  // A hook that could not read the reflog stores the head at entry, here
  // already past the commit.
  rewriteTurnBaselines(install, turn.sessionId, (record) => ({
    ...record,
    roots: record.roots.map((entry) => (entry.root === worktree ? { ...entry, head: sha } : entry)),
  }));

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
});

test('a commit in the same second as the submit is reported, not taken as the baseline', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'same-second');
  const { submittedAt } = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  const submitSecond = () => `@${Math.floor(Date.parse(submittedAt) / 1000)} +0000`;
  const sha = commitDuringTurn(install, worktree, 'one.txt', submitSecond);

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
});

test('EnterWorktree names the entered worktree even when the hook cwd still shows the old directory', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'response-path');
  const turn = startTurn(install, repo);
  enterWorktree(turn, worktree, { cwd: repo });
  const record = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.equal(record.currentRoot, worktree);
  assert.deepEqual(record.roots.map((entry) => entry.root), [repo, worktree]);
});

test('without any reflog, a subdirectory turn still takes the prompt baseline', () => {
  const install = makeInstall();
  const repo = makeRepo(install, { reflog: false });
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const sha = commitDuringTurn(install, repo, 'b.txt');
  const subdirectory = path.join(repo, 'sub');
  cwdChanged(turn, repo, subdirectory);

  const { event } = onlyEvent(turn, stopTurn(turn, subdirectory));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
});

test('the reflog head the CwdChanged hook stored is used when Stop can no longer read the reflog', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'lost-reflog');
  const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const sameCommand = commitDuringTurn(install, worktree, 'one.txt');
  cwdChanged(turn, repo, worktree);
  const later = commitDuringTurn(install, worktree, 'two.txt');
  // Without its own HEAD log Git answers from the checked-out branch's log,
  // so both go.
  fs.rmSync(path.join(repo, '.git', 'worktrees', 'lost-reflog', 'logs', 'HEAD'));
  fs.rmSync(path.join(repo, '.git', 'logs', 'refs', 'heads', 'worktree-lost-reflog'));

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sameCommand, later]);
});

test('a worktree created during the turn starts from the commit it was created on', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'created-now', DURING_TURN);
  enterWorktree(turn, worktree);
  const sha = commitDuringTurn(install, worktree, 'one.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
});

for (const entry of ['EnterWorktree', 'cd', 'no hook']) {
  test(`a worktree created in the turn from a commit made in it starts from that commit (${entry})`, () => {
    const install = makeInstall();
    const repo = makeRepo(install);
    const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
    const turn = startTurn(install, repo);
    // As after merging a pull request: the new worktree starts from a commit
    // newer than the turn's start.
    const merged = commitDuringTurn(install, repo, 'merged.txt');
    const worktree = addWorktree(install, repo, 'from-new-head', DURING_TURN);
    let own;
    if (entry === 'EnterWorktree') {
      enterWorktree(turn, worktree);
      own = commitDuringTurn(install, worktree, 'one.txt');
    } else {
      // `git worktree add … && cd <worktree> && git commit` in one command.
      own = commitDuringTurn(install, worktree, 'one.txt');
      if (entry === 'cd') cwdChanged(turn, repo, worktree);
    }

    const entries = stopTurn(turn, worktree);
    assert.equal(entries.length, 2, 'the Stop event and the event for the checkout the turn left');
    for (const item of entries) assert.equal(validateGitEvidenceEvent(item.payload), null);
    const event = entries.map((item) => item.payload).find((payload) => payload.repository.branch === 'worktree-from-new-head');
    assert.equal(event.diff.coverage, 'ready');
    assert.equal(event.diff.base_head, merged);
    assert.deepEqual(committedShas(event), [own]);
    // The commit the turn made in the checkout it left is reported too.
    const left = entries.map((item) => item.payload).find((payload) => payload.repository.branch === 'main');
    assert.equal(left.diff.base_head, base);
    assert.deepEqual(committedShas(left), [merged]);
  });
}

test('a commit dated ahead of this machine\'s clock is still the baseline the reflog names', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'skewed');
  const git = gitIn(install, worktree);
  // A teammate's commit from a clock two minutes ahead, fast-forwarded in
  // before the turn.
  const ahead = () => `@${Math.floor(Date.now() / 1000) + 120} +0000`;
  const skewed = git(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'skewed'], ahead);
  git(['merge', '-q', '--ff-only', skewed]);

  const turn = startTurn(install, repo);
  enterWorktree(turn, worktree);
  const own = commitDuringTurn(install, worktree, 'one.txt');
  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, skewed);
  assert.deepEqual(committedShas(event), [own]);
});

test('no Git runs for turn baselines when the service takes no commit evidence', () => {
  const baselineGit = (call) => /--show-toplevel|rev-list|--git-path/.test(call);
  const enter = (install, turn, worktree, env) => runHook(install, GIT_CONTEXT_HANDLER, {
    hook_event_name: 'PostToolUse', session_id: turn.sessionId, prompt_id: turn.promptId,
    cwd: worktree, tool_name: 'EnterWorktree', tool_input: { name: path.basename(worktree) },
    tool_response: { worktreePath: worktree }, transcript_path: turn.transcript,
  }, env);

  // Off at submit: no record is opened, and the entry hook has none to fill.
  const off = makeInstall();
  const offRepo = makeRepo(off);
  const offWorktree = addWorktree(off, offRepo, 'no-evidence');
  disableEvidence(off);
  const offLog = gitCallLog(off);
  const offTurn = startTurn(off, offRepo, offLog.env);
  enter(off, offTurn, offWorktree, offLog.env);
  assert.equal(withDataDir(off, (session) => session.readTurnBaselines(offTurn.sessionId)), null);
  assert.ok(offLog.calls().length > 0, 'the prompt Git metadata still runs Git');
  assert.deepEqual(offLog.calls().filter(baselineGit), []);

  // Turned off after submit: the open record is left as it was.
  const later = makeInstall();
  const laterRepo = makeRepo(later);
  const laterWorktree = addWorktree(later, laterRepo, 'evidence-withdrawn');
  const laterTurn = startTurn(later, laterRepo);
  const before = withDataDir(later, (session) => session.readTurnBaselines(laterTurn.sessionId));
  disableEvidence(later);
  const hookLog = gitCallLog(later, 'hook-git-trace');
  enter(later, laterTurn, laterWorktree, hookLog.env);
  assert.deepEqual(withDataDir(later, (session) => session.readTurnBaselines(laterTurn.sessionId)), before);
  assert.deepEqual(hookLog.calls().filter(baselineGit), []);
});

test('a prompt from outside any repository runs no worktree root lookup', () => {
  const install = makeInstall();
  const outside = tempDir('prism-turn-baselines-outside-');
  const log = gitCallLog(install);
  const turn = startTurn(install, outside, log.env);

  assert.equal(withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId)).currentRoot, null);
  assert.ok(log.calls().some((call) => call.startsWith('rev-parse --is-inside-work-tree')));
  assert.deepEqual(log.calls().filter((call) => call.includes('--show-toplevel')), []);
});

test('a signature check that log.showSignature prints does not hide the reflog baseline', (t) => {
  const keygen = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8' });
  if (keygen.error) {
    t.skip('ssh-keygen is not available');
    return;
  }
  const install = makeInstall();
  const repo = makeRepo(install);
  const key = path.join(install.home, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'me@example.test', '-f', key]);
  const signers = path.join(install.home, 'allowed_signers');
  fs.writeFileSync(signers, `me@example.test ${fs.readFileSync(`${key}.pub`, 'utf8')}`);
  const git = gitIn(install, repo);
  for (const [name, value] of [
    ['gpg.format', 'ssh'], ['user.signingkey', key], ['commit.gpgsign', 'true'],
    ['gpg.ssh.allowedSignersFile', signers], ['log.showSignature', 'true'],
  ]) git(['config', name, value]);
  const worktree = addWorktree(install, repo, 'signed');
  commitDuringTurn(install, worktree, 'before.txt', BEFORE_TURN);
  const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
  assert.match(gitIn(install, worktree)(['log', '-1', '--format=%H']), /signature/, 'git log prints the check');

  const turn = startTurn(install, repo);
  enterWorktree(turn, worktree);
  const own = commitDuringTurn(install, worktree, 'one.txt');
  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.coverage, 'ready');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [own]);
});

test('EnterWorktree points the session Git record at the entered worktree, a subagent\'s does not', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'session-record');
  const turn = startTurn(install, repo);
  const readGit = () => withDataDir(install, (session) => session.readGit(turn.sessionId));
  enterWorktree(turn, worktree, { agent_id: 'subagent-1' });
  assert.equal(readGit().canonicalCwd, repo);

  enterWorktree(turn, worktree);
  const record = readGit();
  assert.equal(record.canonicalCwd, worktree);
  assert.equal(record.value.branch, 'worktree-session-record');
});

for (const hooked of [true, false]) {
  test(`an orphan branch committed in the turn never makes the current head the baseline (${hooked ? 'entry hook' : 'no hook'})`, () => {
    const install = makeInstall();
    const repo = makeRepo(install);
    const worktree = addWorktree(install, repo, 'orphan');
    const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
    const turn = startTurn(install, repo);
    if (hooked) enterWorktree(turn, worktree);
    // A gh-pages style branch: its first commit starts the HEAD log walk
    // from nothing, and Git then answers with the current head.
    const git = gitIn(install, worktree);
    git(['checkout', '-q', '--orphan', 'pages'], DURING_TURN);
    git(['rm', '-rq', '--cached', '.'], DURING_TURN);
    fs.writeFileSync(path.join(worktree, 'page.txt'), 'page\n');
    git(['add', 'page.txt'], DURING_TURN);
    git(['commit', '-q', '-m', 'page'], DURING_TURN);
    git(['checkout', '-qf', 'worktree-orphan'], DURING_TURN);
    const own = commitDuringTurn(install, worktree, 'one.txt');

    const { event } = onlyEvent(turn, stopTurn(turn, worktree));
    if (hooked) {
      assert.equal(event.diff.coverage, 'ready');
      assert.equal(event.diff.base_head, base);
      assert.deepEqual(committedShas(event), [own]);
    } else {
      assert.equal(event.diff.coverage, 'unavailable');
      assert.equal(event.diff.reason, 'baseline_missing');
    }
  });
}

test('without a reflog, a commit made before the entry hook ran is never the baseline', () => {
  const install = makeInstall();
  const repo = makeRepo(install, { reflog: false });
  const worktree = addWorktree(install, repo, 'nolog-late');
  const turn = startTurn(install, repo);
  // `cd <worktree> && git commit`: CwdChanged runs after the commit.
  commitDuringTurn(install, worktree, 'one.txt');
  cwdChanged(turn, repo, worktree);

  const record = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.deepEqual(record.roots.map((entry) => entry.root), [repo], 'no current-head baseline is stored');
  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.coverage, 'unavailable');
  assert.equal(event.diff.reason, 'baseline_missing');
});

test('a committer name holding a tab and a time-like text cannot pass for the reflog time', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const turn = startTurn(install, repo);
  const born = tempDir('prism-turn-baselines-born-');
  const git = gitIn(install, born);
  git(['init', '-q', '-b', 'main'], DURING_TURN);
  git(['config', 'user.name', 'Bob 1 +0000\tx'], DURING_TURN);
  git(['remote', 'add', 'origin', 'https://github.com/acme/born.git'], DURING_TURN);
  commitDuringTurn(install, born, 'first.txt');
  cwdChanged(turn, repo, born);
  commitDuringTurn(install, born, 'second.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, born));
  assert.equal(event.diff.coverage, 'unavailable');
  assert.equal(event.diff.reason, 'baseline_missing');
});

test('the root and reflog lookups share one deadline', async () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const { resolveWorktreeRoot, resolveHeadAt } = require('../lib/git');
  const at = new Date().toISOString();
  assert.equal(await resolveWorktreeRoot(repo), repo);
  assert.equal(await resolveWorktreeRoot(repo, 1000, { deadlineAt: Date.now() - 1 }), null);
  assert.ok(await resolveHeadAt(repo, at));
  assert.equal(await resolveHeadAt(repo, at, { fallbackToCurrent: true, deadlineAt: Date.now() - 1 }), null);
});

test('a repository born during the turn has no baseline rather than its first commit as one', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const turn = startTurn(install, repo);
  const born = tempDir('prism-turn-baselines-born-');
  const git = gitIn(install, born);
  git(['init', '-q', '-b', 'main'], DURING_TURN);
  git(['remote', 'add', 'origin', 'https://github.com/acme/born.git'], DURING_TURN);
  commitDuringTurn(install, born, 'first.txt');
  cwdChanged(turn, repo, born);
  commitDuringTurn(install, born, 'second.txt');

  const record = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.deepEqual(record.roots.map((entry) => entry.root), [repo], 'no baseline is stored for the new repository');
  const { event } = onlyEvent(turn, stopTurn(turn, born));
  assert.equal(event.diff.coverage, 'unavailable');
  assert.equal(event.diff.reason, 'baseline_missing');
});

test('a reflog expired during the turn is not trusted over the baseline recorded on entry', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'expired');
  const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  enterWorktree(turn, worktree);
  const first = commitDuringTurn(install, worktree, 'one.txt');
  gitIn(install, worktree)(['reflog', 'expire', '--expire=now', '--all'], DURING_TURN);
  const second = commitDuringTurn(install, worktree, 'two.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [first, second]);
});

test('returning to the prompt root never records its current head as a baseline', () => {
  const install = makeInstall();
  const repo = makeRepo(install, { reflog: false });
  const worktree = addWorktree(install, repo, 'no-reflog');
  const turn = startTurn(install, repo);
  // As when the prompt-path Git snapshot timed out: no prompt baseline.
  rewriteTurnBaselines(install, turn.sessionId, (record) => ({ ...record, roots: [] }));
  commitDuringTurn(install, repo, 'b.txt');
  enterWorktree(turn, worktree);
  cwdChanged(turn, worktree, repo);

  const record = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.deepEqual(record.roots.map((entry) => entry.root), [worktree]);
  const { event } = onlyEvent(turn, stopTurn(turn, repo));
  assert.equal(event.diff.coverage, 'unavailable');
  assert.equal(event.diff.reason, 'baseline_missing');
});

test('moving outside any worktree clears the current root, so coming back is a new visit', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const outside = tempDir('prism-turn-baselines-outside-');
  const turn = startTurn(install, repo);
  cwdChanged(turn, repo, outside);
  assert.equal(withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId)).currentRoot, null);
  cwdChanged(turn, outside, repo);
  const record = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.equal(record.currentRoot, repo);
  assert.deepEqual(record.roots.map((entry) => [entry.root, entry.source, entry.visit]), [[repo, 'prompt', 2]]);
});

test('when Git cannot name the Stop root, the recorded root containing the directory is used', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'no-git-at-stop');
  const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  enterWorktree(turn, worktree);
  commitDuringTurn(install, worktree, 'one.txt');

  // No Git at all for Stop: the root lookup, the reflog, and the final
  // snapshot all fail, yet the baseline still comes from the record.
  const { event } = onlyEvent(turn, stopTurn(turn, path.join(worktree, 'sub'), { PATH: '/nonexistent' }));
  assert.equal(event.diff.coverage, 'unavailable');
  assert.equal(event.diff.reason, 'final_snapshot_failed');
  assert.equal(event.diff.base_head, base);
  // The repository identity falls back to the session Git record, which
  // EnterWorktree pointed at the worktree.
  assert.equal(event.repository.branch, 'worktree-no-git-at-stop');
});

test('when Git cannot name the Stop root, a recorded root is not used across a nested worktree', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const mainHead = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const worktree = addWorktree(install, repo, 'unrecorded');
  commitDuringTurn(install, worktree, 'before.txt', BEFORE_TURN);
  const turn = startTurn(install, repo);
  // No entry hook ran, so only the prompt root (which contains the worktree
  // directory) is recorded.
  commitDuringTurn(install, worktree, 'one.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, worktree, { PATH: '/nonexistent' }));
  assert.equal(event.diff.coverage, 'unavailable');
  assert.notEqual(event.diff.base_head, mainHead);
  assert.equal(event.diff.base_head, undefined);
});

test('without a known prompt root, an entered root is never given its current head as a baseline', () => {
  const install = makeInstall();
  const repo = makeRepo(install, { reflog: false });
  const turn = startTurn(install, repo);
  // As when the prompt-path root lookup timed out: the prompt root is unknown.
  rewriteTurnBaselines(install, turn.sessionId, (record) => ({
    ...record, promptRoot: null, currentRoot: null, roots: [],
  }));
  const sha = commitDuringTurn(install, repo, 'b.txt');
  const subdirectory = path.join(repo, 'sub');
  cwdChanged(turn, repo, subdirectory);

  const record = withDataDir(install, (session) => session.readTurnBaselines(turn.sessionId));
  assert.deepEqual(record.roots, [], 'no current-head baseline is stored');
  const { event } = onlyEvent(turn, stopTurn(turn, subdirectory));
  assert.notEqual(event.diff.base_head, sha);
  assert.equal(event.diff.reason, 'baseline_missing');
});

// Rewrites the install's capability cache, as the hooks would find it.
function setCapability(install, change) {
  const file = path.join(install.dataDir, 'runtime', `git-evidence-capability-${bindingDigest(API_KEY, INGEST_URL)}.json`);
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8')))));
}

function skipReasons(install) {
  const file = path.join(install.dataDir, 'debug.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => (line.match(/^\[git-evidence \S+\] skip reason=(\S+)/) || [])[1])
    .filter(Boolean);
}

const HOURS = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

test('an hour-old capability cache still captures the turn into the outbox for a later delivery', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  setCapability(install, (snapshot) => ({ ...snapshot, last_success_at: HOURS(2), checked_at: HOURS(2) }));
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'stale-cache');
  enterWorktree(turn, worktree);
  const sha = commitDuringTurn(install, worktree, 'one.txt');

  const { entry, event } = onlyEvent(turn, stopTurn(turn, worktree));
  assert.equal(event.diff.coverage, 'ready', 'not baseline_missing');
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
  assert.equal(entry.bindingDigest, bindingDigest(API_KEY, INGEST_URL), 'queued under the binding it was captured for');
});

test('a refusal the service confirmed captures nothing and says why, without repeating the line', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  setCapability(install, (snapshot) => {
    const { endpoint, versions, ...rest } = snapshot;
    return { ...rest, state: 'unsupported' };
  });
  for (let index = 0; index < 2; index += 1) {
    const turn = startTurn(install, repo);
    commitDuringTurn(install, repo, `file-${index}.txt`);
    assert.deepEqual(stopTurn(turn, repo), []);
  }
  const reasons = skipReasons(install).filter((reason) => reason === 'capability_unsupported');
  assert.ok(reasons.length >= 1);
  assert.ok(reasons.length <= 2, 'at most once per session and hour (two sessions here)');
});

test('commits made in a worktree the turn left are reported next to its Stop event', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const left = addWorktree(install, repo, 'left-a');
  const stop = addWorktree(install, repo, 'stop-b');
  const leftBase = gitIn(install, left)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, left);
  const leftSha = commitDuringTurn(install, left, 'a.txt');
  enterWorktree(turn, stop);
  const stopSha = commitDuringTurn(install, stop, 'b.txt');

  const entries = stopTurn(turn, stop);
  assert.equal(entries.length, 2);
  const byBranch = Object.fromEntries(entries.map((item) => [item.payload.repository.branch, item]));
  const stopEvent = byBranch['worktree-stop-b'].payload;
  const leftEntry = byBranch['worktree-left-a'];
  assert.deepEqual(committedShas(stopEvent), [stopSha]);
  assert.deepEqual(committedShas(leftEntry.payload), [leftSha]);
  assert.equal(leftEntry.payload.diff.base_head, leftBase);
  assert.equal(leftEntry.payload.repository.head, leftSha, 'the head the turn left it at');
  assert.equal(leftEntry.payload.repository.dirty, undefined, 'no git status for a left worktree');
  assert.equal(validateGitEvidenceEvent(leftEntry.payload), null);
  assert.notEqual(leftEntry.eventId, byBranch['worktree-stop-b'].eventId);
  for (const key of ['client_event_id', 'host_prompt_id', 'server_prompt_id', 'response_operation_id']) {
    assert.equal(leftEntry.payload[key], stopEvent[key], `same ${key} as the turn's own event`);
  }
});

test('a binding with no capability cache yet is refreshed at Stop and its turn captured in that Stop', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  // As right after an API key change: nothing cached for this binding.
  disableEvidence(install);
  const turn = startTurn(install, repo);
  const sha = commitDuringTurn(install, repo, 'b.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, repo, { PRISM_TEST_CAPABILITY: 'supported' }));
  assert.equal(event.diff.base_head, base);
  assert.deepEqual(committedShas(event), [sha]);
});

test('a worktree the turn left without committing adds no event', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const left = addWorktree(install, repo, 'quiet-a');
  const stop = addWorktree(install, repo, 'busy-b');
  const turn = startTurn(install, left);
  enterWorktree(turn, stop);
  commitDuringTurn(install, stop, 'b.txt');
  onlyEvent(turn, stopTurn(turn, stop));
});

test('returning to the first worktree reports only the other one as left', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const first = addWorktree(install, repo, 'back-a');
  const visited = addWorktree(install, repo, 'visited-b');
  const turn = startTurn(install, first);
  enterWorktree(turn, visited);
  const visitedSha = commitDuringTurn(install, visited, 'b.txt');
  enterWorktree(turn, first);
  const firstSha = commitDuringTurn(install, first, 'a.txt');

  const entries = stopTurn(turn, first);
  assert.equal(entries.length, 2);
  const byBranch = Object.fromEntries(entries.map((item) => [item.payload.repository.branch, item.payload]));
  assert.deepEqual(committedShas(byBranch['worktree-back-a']), [firstSha]);
  assert.deepEqual(committedShas(byBranch['worktree-visited-b']), [visitedSha]);
});

test('two worktrees of one repository the turn left get distinct event ids', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const a = addWorktree(install, repo, 'chain-a');
  const b = addWorktree(install, repo, 'chain-b');
  const c = addWorktree(install, repo, 'chain-c');
  const turn = startTurn(install, a);
  commitDuringTurn(install, a, 'a.txt');
  enterWorktree(turn, b);
  commitDuringTurn(install, b, 'b.txt');
  enterWorktree(turn, c);
  commitDuringTurn(install, c, 'c.txt');

  const entries = stopTurn(turn, c);
  assert.equal(entries.length, 3);
  assert.equal(new Set(entries.map((item) => item.eventId)).size, 3);
  assert.equal(new Set(entries.map((item) => item.payload.repository.root_fingerprint)).size, 1, 'one repository');
});

test('a left worktree is reported up to the head the turn left it at, not a later commit there', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const left = addWorktree(install, repo, 'bounded-a');
  const stop = addWorktree(install, repo, 'bounded-b');
  const turn = startTurn(install, left);
  const mine = commitDuringTurn(install, left, 'mine.txt');
  enterWorktree(turn, stop);
  // Another session commits in the worktree this turn already left.
  commitDuringTurn(install, left, 'theirs.txt');
  commitDuringTurn(install, stop, 'b.txt');

  const entries = stopTurn(turn, stop);
  const leftEvent = entries.map((item) => item.payload).find((payload) => payload.repository.branch === 'worktree-bounded-a');
  assert.deepEqual(committedShas(leftEvent), [mine]);
});

test('at most four worktrees the turn left are reported, and the rest is logged', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const names = ['many-a', 'many-b', 'many-c', 'many-d', 'many-e', 'many-stop'];
  const worktrees = names.map((name) => addWorktree(install, repo, name));
  const turn = startTurn(install, worktrees[0]);
  commitDuringTurn(install, worktrees[0], 'a.txt');
  for (const worktree of worktrees.slice(1)) {
    enterWorktree(turn, worktree);
    commitDuringTurn(install, worktree, `${path.basename(worktree)}.txt`);
  }

  const entries = stopTurn(turn, worktrees[worktrees.length - 1]);
  assert.equal(entries.length, 5, 'the Stop event and four left worktrees');
  assert.ok(skipReasons(install).includes('leave_budget_exhausted'));
});

test('a worktree removed after the turn left it is logged, and the Stop event is unaffected', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const gone = addWorktree(install, repo, 'gone-a');
  const stop = addWorktree(install, repo, 'kept-b');
  const turn = startTurn(install, gone);
  commitDuringTurn(install, gone, 'a.txt');
  enterWorktree(turn, stop);
  gitIn(install, repo)(['worktree', 'remove', '--force', gone], DURING_TURN);
  const sha = commitDuringTurn(install, stop, 'b.txt');

  const { event } = onlyEvent(turn, stopTurn(turn, stop));
  assert.deepEqual(committedShas(event), [sha]);
  assert.ok(skipReasons(install).includes('leave_root_gone'));
});

test('enterTurnRoot keeps, advances, or replaces a root baseline as its visits require', () => {
  const install = makeInstall();
  const sessionId = 'enter-turn-root-session';
  const expected = { epoch: 3, clientEventId: 'client-event' };
  const head = (digit) => digit.repeat(40);
  const at = (second) => `2026-11-04T00:00:0${second}.000Z`;
  withDataDir(install, (session) => {
    session.startTurnBaselines(sessionId, {
      ...expected,
      submittedAt: at(0),
      currentRoot: '/repo',
      promptBaseline: { root: '/repo', head: head('a'), observedAt: at(0) },
    });
    const visits = () => session.readTurnBaselines(sessionId);
    const enter = (entry) => session.enterTurnRoot(sessionId, expected, { observedAt: at(1), source: 'cwd_changed', ...entry });

    assert.equal(session.enterTurnRoot(sessionId, { ...expected, clientEventId: 'other-turn' }, { root: '/wt', head: head('b') }), null);
    const start = visits();
    enter({ root: '/repo', head: head('c') });
    assert.deepEqual(visits(), start, 'entering the current root is a no-op');
    enter({ root: '/wt', head: null });
    assert.deepEqual(visits(), start, 'a new root without a head changes nothing, current root included');

    enter({ root: '/wt', head: head('b') });
    assert.equal(visits().currentRoot, '/wt');
    enter({ root: '/repo', head: null });
    enter({ root: '/wt', head: head('d') });
    assert.deepEqual(visits().roots.map((entry) => [entry.root, entry.head, entry.visit]), [
      ['/repo', head('a'), 2],
      ['/wt', head('b'), 2],
    ], 'a re-entered root keeps the baseline it already had');

    enter({ root: '/repo', head: null });
    rewriteTurnBaselines(install, sessionId, (record) => ({
      ...record,
      roots: record.roots.map((entry) => (entry.root === '/wt' ? { ...entry, emittedAt: at(5) } : entry)),
    }));
    enter({ root: '/wt', head: head('e'), observedAt: at(6), source: 'enter_worktree' });
    assert.deepEqual(visits().roots.find((entry) => entry.root === '/wt'), {
      root: '/wt', head: head('e'), observedAt: at(6), source: 'enter_worktree', visit: 3,
    }, 'a root whose baseline was emitted takes the new one');
  });
});

// Runs the leave collection of a later hook on its own, in a hook process.
function runLeaveCapture(install, sessionId, deadlineMs, env = {}) {
  const script = [
    `const { captureLeaveEvidence } = require(${JSON.stringify(STOP_HANDLER)});`,
    `captureLeaveEvidence(${JSON.stringify(sessionId)}, { deadlineMs: ${deadlineMs} })`,
    '  .then((ids) => process.stdout.write(JSON.stringify(ids)));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', env: { ...install.hookEnv, ...env }, timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function leaveTurn(roots, extra = {}) {
  return {
    epoch: 1,
    clientEventId: crypto.randomUUID(),
    submitPromptId: crypto.randomUUID(),
    serverPromptId: SERVER_PROMPT_ID,
    responseOperationId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    roots,
    ...extra,
  };
}

function leaveRoots(install, sessionId) {
  return withDataDir(install, (session) => {
    const record = session.readLeaveCaptures(sessionId);
    return record ? record.turns.flatMap((turn) => turn.roots.map((root) => root.root)) : [];
  });
}

test('a left worktree that runs out of time is kept and reported by a later hook', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'late-a');
  const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
  const sha = commitDuringTurn(install, worktree, 'a.txt');
  const sessionId = `session-${crypto.randomUUID()}`;
  const turn = leaveTurn([{ root: worktree, baselineHead: base, leftHead: sha }]);
  withDataDir(install, (session) => assert.equal(session.appendLeaveCapture(sessionId, turn).written, true));

  assert.deepEqual(runLeaveCapture(install, sessionId, 0), []);
  assert.deepEqual(leaveRoots(install, sessionId), [worktree], 'kept for a later hook');
  assert.ok(skipReasons(install).includes('leave_budget_exhausted'));

  const ids = runLeaveCapture(install, sessionId, 5000);
  assert.equal(ids.length, 1);
  const { entry, event } = onlyEvent({ sessionId }, evidenceFor({ install, sessionId }));
  assert.equal(entry.eventId, ids[0]);
  assert.deepEqual(committedShas(event), [sha]);
  assert.equal(event.response_operation_id, turn.responseOperationId);
  assert.equal(event.observed_at, turn.createdAt, 'observed when the turn was recorded, not when collected');
  assert.deepEqual(leaveRoots(install, sessionId), [], 'settled once queued');
});

test('a left worktree whose baseline is no longer an ancestor is logged and settled without an event', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'rewritten-a');
  const git = gitIn(install, worktree);
  const base = commitDuringTurn(install, worktree, 'before.txt');
  // The history is rewritten past the baseline: it is no ancestor of the head.
  git(['reset', '-q', '--hard', 'HEAD~1'], DURING_TURN);
  const sha = commitDuringTurn(install, worktree, 'after.txt');
  const sessionId = `session-${crypto.randomUUID()}`;
  withDataDir(install, (session) => session.appendLeaveCapture(sessionId, leaveTurn([
    { root: worktree, baselineHead: base, leftHead: sha },
  ])));

  assert.deepEqual(runLeaveCapture(install, sessionId, 5000), []);
  assert.deepEqual(evidenceFor({ install, sessionId }), []);
  assert.ok(skipReasons(install).includes('leave_non_ancestor'));
  assert.deepEqual(leaveRoots(install, sessionId), []);
});

test('a later turn\'s leave captures are added next to an earlier turn still waiting', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const first = addWorktree(install, repo, 'waiting-a');
  const second = addWorktree(install, repo, 'waiting-b');
  const firstBase = gitIn(install, first)(['rev-parse', 'HEAD']);
  const secondBase = gitIn(install, second)(['rev-parse', 'HEAD']);
  const firstSha = commitDuringTurn(install, first, 'a.txt');
  const secondSha = commitDuringTurn(install, second, 'b.txt');
  const sessionId = `session-${crypto.randomUUID()}`;
  const earlier = leaveTurn([{ root: first, baselineHead: firstBase, leftHead: firstSha }]);
  withDataDir(install, (session) => {
    session.appendLeaveCapture(sessionId, earlier);
    session.appendLeaveCapture(sessionId, leaveTurn([{ root: second, baselineHead: secondBase, leftHead: secondSha }]));
    // The same turn appended again replaces its own entry.
    session.appendLeaveCapture(sessionId, earlier);
  });
  assert.deepEqual(leaveRoots(install, sessionId).sort(), [first, second].sort());

  assert.equal(runLeaveCapture(install, sessionId, 5000).length, 2);
  const shas = evidenceFor({ install, sessionId }).map((item) => committedShas(item.payload)).flat();
  assert.deepEqual(shas.sort(), [firstSha, secondSha].sort());
});

test('only the newest turns\' leave captures are kept, and the overflow is counted', () => {
  const install = makeInstall();
  const sessionId = 'leave-overflow-session';
  const head = 'a'.repeat(40);
  withDataDir(install, (session) => {
    const turns = Array.from({ length: 9 }, (_, index) => leaveTurn([{ root: `/wt-${index}`, baselineHead: head }]));
    const results = turns.map((turn) => session.appendLeaveCapture(sessionId, turn));
    assert.deepEqual(results.map((result) => result.dropped), [0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const kept = session.readLeaveCaptures(sessionId).turns.map((turn) => turn.responseOperationId);
    assert.deepEqual(kept, turns.slice(1).map((turn) => turn.responseOperationId));

    assert.equal(session.settleLeaveCaptureRoots(sessionId, new Set(turns.slice(1).map((turn) => session.leaveCaptureKey(turn, turn.roots[0])))), true);
    assert.equal(session.readLeaveCaptures(sessionId), null, 'removed once every root is settled');
  });
});

test('enterTurnRoot records the head a root was left at only for the root actually left', () => {
  const install = makeInstall();
  const sessionId = 'enter-turn-root-left-head';
  const expected = { epoch: 1, clientEventId: 'client-event' };
  const head = (digit) => digit.repeat(40);
  const at = (second) => `2026-11-04T00:00:0${second}.000Z`;
  withDataDir(install, (session) => {
    session.startTurnBaselines(sessionId, {
      ...expected,
      submittedAt: at(0),
      currentRoot: '/repo',
      promptBaseline: { root: '/repo', head: head('a'), observedAt: at(0) },
    });
    const enter = (entry) => session.enterTurnRoot(sessionId, expected, { observedAt: at(1), source: 'cwd_changed', ...entry });
    const leftHeadOf = (root) => session.readTurnBaselines(sessionId).roots.find((entry) => entry.root === root).leftHead;

    enter({ root: '/wt', head: head('b'), leaving: '/repo', leftHead: head('c') });
    assert.equal(leftHeadOf('/repo'), head('c'));
    // A hook that read a stale record names a root the turn is no longer in.
    enter({ root: '/other', head: head('d'), leaving: '/repo', leftHead: head('e') });
    assert.equal(leftHeadOf('/repo'), head('c'), 'not overwritten by a root that was not the current one');
    assert.equal(leftHeadOf('/wt'), undefined);
    enter({ root: '/repo', head: null, leaving: '/other', leftHead: head('f') });
    assert.equal(leftHeadOf('/repo'), undefined, 're-entering a root drops the head it was left at');
    assert.equal(leftHeadOf('/other'), head('f'));
  });
});

// The 11-09 loss: a session idle past the capability cache's hour commits in
// one worktree, moves to another and commits there, while the refresh at
// Stop cannot reach the service. Both commits must wait in the outbox.
for (const move of ['EnterWorktree', 'cd without a hook']) {
  test(`an idle session's commits in the worktree it left and the one it ended in are both queued (${move})`, () => {
    const install = makeInstall();
    const repo = makeRepo(install);
    const first = addWorktree(install, repo, 'idle-a');
    const second = addWorktree(install, repo, 'idle-b');
    const firstBase = gitIn(install, first)(['rev-parse', 'HEAD']);
    setCapability(install, (snapshot) => ({ ...snapshot, last_success_at: HOURS(3), checked_at: HOURS(3) }));
    const turn = startTurn(install, first);
    const firstSha = commitDuringTurn(install, first, 'a.txt');
    if (move === 'EnterWorktree') enterWorktree(turn, second);
    const secondSha = commitDuringTurn(install, second, 'b.txt');

    const entries = stopTurn(turn, second);
    assert.equal(entries.length, 2);
    const byBranch = Object.fromEntries(entries.map((item) => [item.payload.repository.branch, item]));
    assert.deepEqual(committedShas(byBranch['worktree-idle-a'].payload), [firstSha]);
    assert.equal(byBranch['worktree-idle-a'].payload.diff.base_head, firstBase);
    assert.deepEqual(committedShas(byBranch['worktree-idle-b'].payload), [secondSha]);
    for (const item of entries) {
      assert.equal(validateGitEvidenceEvent(item.payload), null);
      assert.equal(item.bindingDigest, bindingDigest(API_KEY, INGEST_URL));
    }
    assert.ok(skipReasons(install).includes('delivery_stale'), 'delivery waits for a refresh that succeeds');
    assert.ok(!skipReasons(install).some((reason) => reason.startsWith('capability_')), 'capture was never refused');
  });
}

test('commits made in a worktree the turn entered and then exited (no hook on exit) are reported at Stop in the main checkout', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const base = gitIn(install, repo)(['rev-parse', 'HEAD']);
  const turn = startTurn(install, repo);
  const worktree = addWorktree(install, repo, 'exited-b', DURING_TURN);
  enterWorktree(turn, worktree);
  const sha = commitDuringTurn(install, worktree, 'b.txt');
  // ExitWorktree returns the session to the main checkout with no hook.

  const entries = stopTurn(turn, repo);
  const payloads = entries.map((item) => item.payload);
  const leftEvent = payloads.find((payload) => payload.repository.branch === 'worktree-exited-b');
  assert.ok(leftEvent, 'the exited worktree is reported');
  assert.equal(leftEvent.diff.base_head, base);
  assert.deepEqual(committedShas(leftEvent), [sha]);
  const own = payloads.find((payload) => payload.repository.branch === 'main');
  assert.ok(own, 'the turn\'s own Stop event is still there');
  assert.deepEqual(committedShas(own), []);
});

// A Git whose `status` is too slow for the submit-time read (its 250ms
// budget), as on a cold or large work tree: the prompt root then gets no
// baseline at submit, while the root lookup itself still answers.
function slowStatusGit(install) {
  return slowGit(install, 'status', 0.4);
}

// A Git that sleeps `seconds` before running `subcommand`.
function slowGit(install, subcommand, seconds) {
  const dir = path.join(install.home, `slow-${subcommand}-bin`);
  fs.mkdirSync(dir, { recursive: true });
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `for arg in "$@"; do [ "$arg" = ${subcommand} ] && sleep ${seconds}; done`,
    `exec "${real}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  // The first run of a new executable can be slow (the OS checks it), which
  // would push the submit-time root lookup past its own budget too.
  execFileSync(path.join(dir, 'git'), ['--version']);
  return { PATH: `${dir}${path.delimiter}${process.env.PATH}` };
}

// EnterWorktree: the leaving hook recovers the prompt baseline and the head
// the turn left the root at. A plain cd: no hook sees the move, and Stop
// reads the baseline from the reflog itself.
for (const move of ['EnterWorktree', 'cd without a hook']) {
  test(`a prompt root the submit-time read missed is still reported once the turn leaves it, from its reflog (${move})`, () => {
    const install = makeInstall();
    const repo = makeRepo(install);
    const first = addWorktree(install, repo, 'slow-a');
    const second = addWorktree(install, repo, 'slow-b');
    const base = gitIn(install, first)(['rev-parse', 'HEAD']);
    const turn = startTurn(install, first, slowStatusGit(install));
    assert.ok(skipReasons(install).includes('prompt_baseline_missing'), JSON.stringify(skipReasons(install)));
    const firstSha = commitDuringTurn(install, first, 'a.txt');
    if (move === 'EnterWorktree') {
      enterWorktree(turn, second);
      // Another session commits in the prompt root after the turn left it.
      commitDuringTurn(install, first, 'theirs.txt');
    }
    const secondSha = commitDuringTurn(install, second, 'b.txt');

    const entries = stopTurn(turn, second);
    assert.equal(entries.length, 2);
    const byBranch = Object.fromEntries(entries.map((item) => [item.payload.repository.branch, item.payload]));
    assert.deepEqual(committedShas(byBranch['worktree-slow-a']), [firstSha], 'up to the head the turn left it at');
    assert.equal(byBranch['worktree-slow-a'].diff.base_head, base, 'the head at submit, not one with the turn\'s commit');
    assert.equal(validateGitEvidenceEvent(byBranch['worktree-slow-a']), null);
    assert.deepEqual(committedShas(byBranch['worktree-slow-b']), [secondSha]);
  });
}

test('enterTurnRoot records a prompt baseline the leaving hook recovered only for the unrecorded current prompt root', () => {
  const install = makeInstall();
  const head = (digit) => digit.repeat(40);
  const at = (second) => `2026-11-04T00:00:0${second}.000Z`;
  withDataDir(install, (session) => {
    const start = (sessionId, promptBaseline = null) => {
      const expected = { epoch: 1, clientEventId: `client-${sessionId}` };
      session.startTurnBaselines(sessionId, { ...expected, submittedAt: at(0), currentRoot: '/repo', promptBaseline });
      return (entry) => session.enterTurnRoot(sessionId, expected, { observedAt: at(1), source: 'enter_worktree', ...entry });
    };
    const rootsOf = (sessionId) => session.readTurnBaselines(sessionId).roots
      .map((item) => [item.root, item.head, item.source, item.observedAt, item.leftHead]);

    start('recovered')({ root: '/wt', head: head('b'), promptHead: head('a'), leaving: '/repo', leftHead: head('c') });
    assert.deepEqual(rootsOf('recovered'), [
      ['/repo', head('a'), 'prompt', at(0), head('c')],
      ['/wt', head('b'), 'enter_worktree', at(1), undefined],
    ], 'recorded as the prompt baseline at submit, then left');

    const recorded = start('recorded', { root: '/repo', head: head('d'), observedAt: at(0) });
    recorded({ root: '/wt', head: head('b'), promptHead: head('a'), leaving: '/repo' });
    assert.equal(rootsOf('recorded')[0][1], head('d'), 'a prompt root already recorded keeps its own baseline');

    const moved = start('moved');
    moved({ root: '/wt', head: head('b') });
    moved({ root: '/other', head: head('e'), promptHead: head('a'), leaving: '/repo' });
    assert.ok(!rootsOf('moved').some(([root]) => root === '/repo'), 'not once the turn is no longer in the prompt root');
  });
});

// EnterWorktree records the prompt root on the way out; a plain cd leaves it
// unrecorded, so Stop must still see that it ended there.
for (const move of ['EnterWorktree', 'cd without a hook']) {
  test(`a turn that ends in the prompt root the submit-time read missed reports it once, as its own Stop event (${move})`, () => {
    const install = makeInstall();
    const repo = makeRepo(install);
    const first = addWorktree(install, repo, 'home-a');
    const visited = addWorktree(install, repo, 'away-b');
    const turn = startTurn(install, first, slowStatusGit(install));
    if (move === 'EnterWorktree') enterWorktree(turn, visited);
    const visitedSha = commitDuringTurn(install, visited, 'b.txt');
    // Back to the prompt root with no hook (ExitWorktree, or a plain cd).
    const firstSha = commitDuringTurn(install, first, 'a.txt');

    const entries = stopTurn(turn, path.join(first, 'sub'));
    const home = entries.filter((item) => item.payload.repository.branch === 'worktree-home-a');
    assert.equal(home.length, 1, 'the prompt root once');
    assert.deepEqual(committedShas(home[0].payload), [firstSha]);
    assert.equal(home[0].eventId, deriveEvidenceEventId(home[0].payload.response_operation_id), 'the Stop event, not a leave event');
    const away = entries.filter((item) => item.payload.repository.branch === 'worktree-away-b');
    // A worktree entered with no hook is never recorded (a known gap).
    assert.deepEqual(away.map((item) => committedShas(item.payload)), move === 'EnterWorktree' ? [[visitedSha]] : []);
  });
}

test('a prompt root the submit-time read missed and that keeps no reflog is logged, not given its current head', () => {
  const install = makeInstall();
  const repo = makeRepo(install, { reflog: false });
  const first = addWorktree(install, repo, 'bare-a');
  const second = addWorktree(install, repo, 'bare-b');
  // A commit made before the turn, which the turn fast-forwards to: the
  // current head then predates the submit, yet it is not the baseline.
  const git = gitIn(install, repo);
  git(['switch', '-q', '-c', 'side']);
  fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
  git(['add', 'side.txt']);
  git(['commit', '-q', '-m', 'side']);
  git(['switch', '-q', 'main']);
  const turn = startTurn(install, first, slowStatusGit(install));
  gitIn(install, first)(['merge', '-q', '--ff-only', 'side'], DURING_TURN);
  enterWorktree(turn, second);
  commitDuringTurn(install, second, 'b.txt');

  const entries = stopTurn(turn, second);
  assert.ok(!entries.some((item) => item.payload.repository.branch === 'worktree-bare-a'));
  assert.ok(skipReasons(install).includes('leave_baseline_missing'));
});

test('a leave capture root holds exactly one of a baseline head and the time to read it at', () => {
  const install = makeInstall();
  const head = 'a'.repeat(40);
  const at = new Date().toISOString();
  withDataDir(install, (session) => {
    const write = (root) => session.appendLeaveCapture(`leave-root-shape-${crypto.randomUUID()}`, leaveTurn([root])).written;
    assert.equal(write({ root: '/wt', baselineHead: head }), true);
    assert.equal(write({ root: '/wt', baselineAt: at }), true);
    assert.equal(write({ root: '/wt', baselineAt: at, leftHead: head }), true);
    assert.equal(write({ root: '/wt', baselineHead: head, baselineAt: at }), false);
    assert.equal(write({ root: '/wt' }), false);
    assert.equal(write({ root: '/wt', baselineAt: 'not a time' }), false);
  });
});

const SESSION_START_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'session-start-handler.js');

// A left worktree whose leave capture was recorded but not collected (the
// Stop process ended first), with a commit in it.
function pendingLeave(install, name) {
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, name);
  const base = gitIn(install, worktree)(['rev-parse', 'HEAD']);
  const sha = commitDuringTurn(install, worktree, `${name}.txt`);
  return { worktree, base, sha, root: { root: worktree, baselineHead: base, leftHead: sha } };
}

test('a session that resumes collects the leave captures its last Stop left, after refreshing a missing cache', () => {
  const install = makeInstall();
  const left = pendingLeave(install, 'resumed-a');
  const sessionId = `session-${crypto.randomUUID()}`;
  withDataDir(install, (session) => session.appendLeaveCapture(sessionId, leaveTurn([left.root])));
  // No cache for this binding: the refresh must come before the resume, or
  // the closed gate settles the capture with nothing reported.
  disableEvidence(install);

  runHook(install, SESSION_START_HANDLER, {
    hook_event_name: 'SessionStart', session_id: sessionId, source: 'resume', cwd: left.worktree,
    transcript_path: path.join(install.home, 'transcript-resume.jsonl'),
  }, { PRISM_TEST_CAPABILITY: 'supported' });

  const { event } = onlyEvent({ sessionId }, evidenceFor({ install, sessionId }));
  assert.deepEqual(committedShas(event), [left.sha]);
  assert.deepEqual(leaveRoots(install, sessionId), []);
});

test('a repeated Stop of a published turn refreshes before it resumes the leave captures still waiting', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const turn = startTurn(install, repo);
  stopTurn(turn, repo);
  const left = pendingLeave(install, 'repeated-a');
  withDataDir(install, (session) => session.appendLeaveCapture(turn.sessionId, leaveTurn([left.root])));
  disableEvidence(install);

  // The host runs Stop again for the turn already published.
  const entries = stopTurn(turn, repo, { PRISM_TEST_CAPABILITY: 'supported' });
  const leave = entries.filter((item) => item.payload.repository.branch === 'worktree-repeated-a');
  assert.equal(leave.length, 1);
  assert.deepEqual(committedShas(leave[0].payload), [left.sha]);
});

function runLeaveCaptureAsync(install, sessionId) {
  const { spawn } = require('node:child_process');
  const script = [
    `const { captureLeaveEvidence } = require(${JSON.stringify(STOP_HANDLER)});`,
    `captureLeaveEvidence(${JSON.stringify(sessionId)}, { deadlineMs: 10000 })`,
    '  .then((ids) => process.stdout.write(JSON.stringify(ids)));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, env: install.hookEnv });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out || '[]')) : reject(new Error(`exit ${code}`))));
  });
}

test('two hooks collecting the same leave captures at once queue each event once', async () => {
  const install = makeInstall();
  const a = pendingLeave(install, 'race-a');
  const b = pendingLeave(install, 'race-b');
  const sessionId = `session-${crypto.randomUUID()}`;
  withDataDir(install, (session) => session.appendLeaveCapture(sessionId, leaveTurn([a.root, b.root])));

  await Promise.all([runLeaveCaptureAsync(install, sessionId), runLeaveCaptureAsync(install, sessionId)]);

  const entries = evidenceFor({ install, sessionId });
  assert.equal(entries.length, 2, 'one event per left worktree');
  assert.deepEqual(entries.map((item) => committedShas(item.payload)).flat().sort(), [a.sha, b.sha].sort());
  assert.deepEqual(leaveRoots(install, sessionId), []);
  assert.ok(!skipReasons(install).includes('leave_conflict'), 'both built the same event');
});

function leaveRecordRoots(install, sessionId) {
  return withDataDir(install, (session) => {
    const record = session.readLeaveCaptures(sessionId);
    return record ? record.turns.flatMap((turn) => turn.roots) : [];
  });
}

// Every range lookup takes longer than the 2s leave budget; the turn's own
// 5s capture still fits.
const slowRange = (install) => slowGit(install, 'merge-base', 2.3);

test('a left worktree held over for a later hook is bounded by the head its Stop recorded, not a later turn\'s commit', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'held-a');
  const turn = startTurn(install, repo);
  enterWorktree(turn, worktree);
  const mine = commitDuringTurn(install, worktree, 'mine.txt');
  // Back to the main checkout with no hook (ExitWorktree): no leftHead.
  stopTurn(turn, repo, slowRange(install));
  const [held] = leaveRecordRoots(install, turn.sessionId);
  assert.equal(held.root, worktree, 'kept for a later hook');
  assert.equal(held.leftHead, mine, 'its head when the Stop recorded it');
  assert.equal(held.attempts, 1);

  // The next turn commits there before a later hook collects it.
  commitDuringTurn(install, worktree, 'next-turn.txt');
  runLeaveCapture(install, turn.sessionId, 5000);
  const leave = evidenceFor(turn).filter((item) => item.payload.repository.branch === 'worktree-held-a');
  assert.equal(leave.length, 1);
  assert.deepEqual(committedShas(leave[0].payload), [mine]);
});

test('a left worktree no hook can collect in time is given up on its third try, not held over forever', () => {
  const install = makeInstall();
  const repo = makeRepo(install);
  const worktree = addWorktree(install, repo, 'huge-a');
  const turn = startTurn(install, repo);
  enterWorktree(turn, worktree);
  commitDuringTurn(install, worktree, 'a.txt');
  stopTurn(turn, repo, slowRange(install));
  assert.equal(leaveRecordRoots(install, turn.sessionId)[0].attempts, 1);

  runLeaveCapture(install, turn.sessionId, 2000, slowRange(install));
  assert.equal(leaveRecordRoots(install, turn.sessionId)[0].attempts, 2, 'a second slow hook keeps it');
  assert.ok(!skipReasons(install).includes('leave_range_timeout'));
  runLeaveCapture(install, turn.sessionId, 2000, slowRange(install));
  assert.deepEqual(leaveRecordRoots(install, turn.sessionId), []);
  assert.ok(skipReasons(install).includes('leave_range_timeout'));
});

function runLeaveCaptureRecordedBy(install, sessionId, recordedBy) {
  const script = [
    `const { captureLeaveEvidence } = require(${JSON.stringify(STOP_HANDLER)});`,
    `captureLeaveEvidence(${JSON.stringify(sessionId)}, { deadlineMs: 5000, recordedBy: ${JSON.stringify(recordedBy)} })`,
    '  .then((ids) => process.stdout.write(JSON.stringify(ids)));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: install.hookEnv, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// A left root the Stop could not read the head of: committed in before the
// turn was recorded, then again (by the next turn) after it.
function rootWithoutLeftHead(install, { reflog = true } = {}) {
  const repo = makeRepo(install, { reflog });
  const worktree = addWorktree(install, repo, 'unbounded-a');
  const git = gitIn(install, worktree);
  const base = git(['rev-parse', 'HEAD']);
  const before = () => `@${Math.floor(Date.now() / 1000) - 60} +0000`;
  fs.writeFileSync(path.join(worktree, 'mine.txt'), 'mine\n');
  git(['add', 'mine.txt'], before);
  git(['commit', '-q', '-m', 'mine'], before);
  const mine = git(['rev-parse', 'HEAD'], before);
  const turn = leaveTurn([{ root: worktree, baselineHead: base }]);
  const next = commitDuringTurn(install, worktree, 'next-turn.txt');
  return { worktree, mine, next, turn };
}

test('a left root with no recorded head is bounded at the time its turn was recorded when a later hook collects it', () => {
  const install = makeInstall();
  const left = rootWithoutLeftHead(install);
  const later = `session-${crypto.randomUUID()}`;
  withDataDir(install, (session) => session.appendLeaveCapture(later, left.turn));
  runLeaveCaptureRecordedBy(install, later, null);
  const { event } = onlyEvent({ sessionId: later }, evidenceFor({ install, sessionId: later }));
  assert.deepEqual(committedShas(event), [left.mine], 'not the next turn\'s commit');

  // The Stop that recorded the turn itself may take the head now.
  const sameStop = `session-${crypto.randomUUID()}`;
  const install2 = makeInstall();
  const left2 = rootWithoutLeftHead(install2);
  withDataDir(install2, (session) => session.appendLeaveCapture(sameStop, left2.turn));
  runLeaveCaptureRecordedBy(install2, sameStop, left2.turn.responseOperationId);
  const own = onlyEvent({ sessionId: sameStop }, evidenceFor({ install: install2, sessionId: sameStop }));
  assert.deepEqual(committedShas(own.event), [left2.mine, left2.next]);
});

test('a left root with no recorded head and no reflog is not given a head committed after its turn', () => {
  const install = makeInstall();
  const left = rootWithoutLeftHead(install, { reflog: false });
  const sessionId = `session-${crypto.randomUUID()}`;
  withDataDir(install, (session) => session.appendLeaveCapture(sessionId, left.turn));
  runLeaveCaptureRecordedBy(install, sessionId, null);
  assert.deepEqual(evidenceFor({ install, sessionId }), []);
  assert.ok(skipReasons(install).includes('leave_final_head_missing'));
  assert.deepEqual(leaveRoots(install, sessionId), []);
});

test('a root that only ran out of the time other roots used is kept without counting a try', () => {
  const install = makeInstall();
  const first = pendingLeave(install, 'early-a');
  const second = pendingLeave(install, 'late-b');
  const sessionId = `session-${crypto.randomUUID()}`;
  withDataDir(install, (session) => session.appendLeaveCapture(sessionId, leaveTurn([first.root, second.root])));
  // The first root takes most of the 2s; the second starts with less than
  // half of it, runs out, and is not to blame.
  runLeaveCapture(install, sessionId, 2000, slowGit(install, 'merge-base', 1.4));
  const left = leaveRecordRoots(install, sessionId);
  assert.deepEqual(left.map((root) => root.root), [second.worktree]);
  assert.equal(left[0].attempts, undefined);
  assert.equal(evidenceFor({ install, sessionId }).length, 1, 'the first root was reported');
});

test('leave captures recorded under another API key or ingest are settled unsent, and their events carry the binding recorded', () => {
  const install = makeInstall();
  const other = pendingLeave(install, 'other-binding');
  const mine = pendingLeave(install, 'my-binding');
  const sessionId = `session-${crypto.randomUUID()}`;
  const digest = bindingDigest(API_KEY, INGEST_URL);
  withDataDir(install, (session) => {
    session.appendLeaveCapture(sessionId, leaveTurn([other.root], { bindingDigest: 'f'.repeat(64) }));
    session.appendLeaveCapture(sessionId, leaveTurn([mine.root], { bindingDigest: digest }));
  });

  runLeaveCapture(install, sessionId, 5000);
  const { entry, event } = onlyEvent({ sessionId }, evidenceFor({ install, sessionId }));
  assert.deepEqual(committedShas(event), [mine.sha]);
  assert.equal(entry.bindingDigest, digest);
  assert.ok(skipReasons(install).includes('binding_mismatch'));
  assert.deepEqual(leaveRoots(install, sessionId), []);
});

test('a left root still at its baseline is settled without running Git', () => {
  const install = makeInstall();
  const sessionId = `session-${crypto.randomUUID()}`;
  const head = 'a'.repeat(40);
  // A path that is no repository: any Git run would settle it as gone.
  withDataDir(install, (session) => session.appendLeaveCapture(sessionId, leaveTurn([
    { root: path.join(install.home, 'no-such-worktree'), baselineHead: head, leftHead: head },
  ])));
  assert.deepEqual(runLeaveCapture(install, sessionId, 5000), []);
  assert.deepEqual(leaveRoots(install, sessionId), []);
  assert.ok(!skipReasons(install).includes('leave_root_gone'));
});

test('a turn\'s full set of recorded roots and an unrecorded prompt root fit one leave capture', () => {
  const install = makeInstall();
  const head = 'b'.repeat(40);
  withDataDir(install, (session) => {
    const roots = Array.from({ length: 64 }, (_, index) => ({ root: `/wt-${index}`, baselineHead: head }));
    roots.unshift({ root: '/prompt', baselineAt: new Date().toISOString() });
    assert.equal(session.appendLeaveCapture('leave-root-cap', leaveTurn(roots)).written, true);
  });
});

test('enterTurnRoot keeps what it learned about the root left even when the entered root cannot be recorded', () => {
  const install = makeInstall();
  const head = (digit) => digit.repeat(40);
  const at = (second) => `2026-11-04T00:00:0${second}.000Z`;
  withDataDir(install, (session) => {
    const sessionId = 'enter-turn-root-unrecorded-target';
    const expected = { epoch: 1, clientEventId: 'client-event' };
    session.startTurnBaselines(sessionId, { ...expected, submittedAt: at(0), currentRoot: '/repo', promptBaseline: null });
    const enter = (entry) => session.enterTurnRoot(sessionId, expected, { observedAt: at(1), source: 'enter_worktree', ...entry });

    enter({ root: '/wt', head: null });
    assert.equal(session.readTurnBaselines(sessionId).currentRoot, '/repo', 'nothing learned: unchanged');
    enter({ root: '/wt', head: null, promptHead: head('a'), leaving: '/repo', leftHead: head('c') });
    const record = session.readTurnBaselines(sessionId);
    assert.deepEqual(record.roots.map((item) => [item.root, item.head, item.leftHead]), [['/repo', head('a'), head('c')]]);
    assert.equal(record.currentRoot, null, 'so a return to /repo is a new visit and /wt can still be recorded');
  });
});
