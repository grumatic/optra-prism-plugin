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
    "    response.statusCode = pathname === '/v1/prompts' ? 201 : pathname === '/v1/prompts/response' ? 202 : 503;",
    '    callback(response);',
    `    if (pathname === '/v1/prompts') response.emit('data', Buffer.from('{"id":"${SERVER_PROMPT_ID}"}'));`,
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

    const { event } = onlyEvent(turn, stopTurn(turn, worktree));
    assert.equal(event.diff.coverage, 'ready');
    assert.equal(event.diff.base_head, merged);
    assert.deepEqual(committedShas(event), [own]);
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
