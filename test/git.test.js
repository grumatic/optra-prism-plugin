const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { collectGitContext, parseRemoteUrl } = require('../lib/git');
const session = require('../lib/session');

const ROOT = path.resolve(__dirname, '..');
const GIT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'git-context-handler.js');
const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const repo = tempDir('prism-git-');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  git(repo, ['config', 'user.name', 'Prism Test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['remote', 'add', 'origin', 'ssh://git@github.com:2222/acme/widget.git']);
  return repo;
}

function withDataDir(dataDir, action) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const restore = () => {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  };
  let result;
  try {
    result = action();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then((value) => { restore(); return value; }, (error) => { restore(); throw error; });
  }
  restore();
  return result;
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('parses sanitized ssh, https, and credential-bearing remotes without retaining source URLs', () => {
  const cases = [
    ['git@github.com:acme/widget.git', { host: 'github.com', owner: 'acme', repo: 'widget' }],
    ['https://gitlab.example:8443/group/project.git', { host: 'gitlab.example', owner: 'group', repo: 'project' }],
    ['https://user:secret@example.test/acme/private.git', { host: 'example.test', owner: 'acme', repo: 'private' }],
  ];

  for (const [remote, expected] of cases) {
    const parsed = parseRemoteUrl(remote);
    assert.deepEqual(parsed, expected);
    assert.equal(JSON.stringify(parsed).includes(remote), false);
    assert.equal(JSON.stringify(parsed).includes('secret'), false);
  }
});

test('collects nearest repositories, dirty state, and linked worktrees', () => withDataDir(tempDir('prism-git-data-'), async () => {
  const repo = makeRepo();
  const clean = await collectGitContext(repo);
  assert.equal(clean.status, 'ok');
  assert.deepEqual(clean.value.host, 'github.com');
  assert.deepEqual(clean.value.owner, 'acme');
  assert.deepEqual(clean.value.repo, 'widget');
  assert.equal(clean.value.dirty, false);
  assert.equal(clean.value.worktree, false);

  fs.appendFileSync(path.join(repo, 'tracked.txt'), 'dirty\n');
  const dirty = await collectGitContext(repo);
  assert.equal(dirty.value.dirty, true);

  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  git(nested, ['init']);
  git(nested, ['config', 'user.email', 'test@example.test']);
  git(nested, ['config', 'user.name', 'Prism Test']);
  fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested\n');
  git(nested, ['add', 'nested.txt']);
  git(nested, ['commit', '-m', 'nested']);
  const nestedContext = await collectGitContext(nested);
  assert.equal(nestedContext.status, 'ok');
  assert.equal(nestedContext.value.head, git(nested, ['rev-parse', 'HEAD']));

  git(repo, ['checkout', '--', 'tracked.txt']);
  const worktree = path.join(path.dirname(repo), `${path.basename(repo)}-worktree`);
  git(repo, ['worktree', 'add', '-b', 'prism-worktree-test', worktree]);
  tempDirs.push(worktree);
  const worktreeContext = await collectGitContext(worktree);
  assert.equal(worktreeContext.status, 'ok');
  assert.equal(worktreeContext.value.worktree, true);
}));

test('reports non-repositories and missing or timed-out git as fail-open states', () => withDataDir(tempDir('prism-git-data-'), async () => {
  const plain = tempDir('prism-not-repo-');
  assert.equal((await collectGitContext(plain)).status, 'not_repo');

  const repo = makeRepo();
  const originalPath = process.env.PATH;
  const missingBin = tempDir('prism-missing-git-');
  try {
    process.env.PATH = missingBin;
    assert.equal((await collectGitContext(repo)).status, 'transient_error');

    const fakeBin = tempDir('prism-fake-git-');
    const fakeGit = path.join(fakeBin, 'git');
    fs.writeFileSync(fakeGit, '#!/bin/sh\n/bin/sleep 1\n');
    fs.chmodSync(fakeGit, 0o755);
    process.env.PATH = fakeBin;
    assert.equal((await collectGitContext(repo)).status, 'transient_error');
  } finally {
    process.env.PATH = originalPath;
  }
}));
test('enforces a shared output budget across git commands', () => withDataDir(tempDir('prism-git-data-'), async () => {
  const repo = makeRepo();
  const fakeBin = tempDir('prism-output-budget-bin-');
  const payload = path.join(fakeBin, 'payload');
  const callLog = path.join(fakeBin, 'calls');
  const fakeGit = path.join(fakeBin, 'git');
  fs.writeFileSync(payload, 'x'.repeat(20 * 1024));
  fs.writeFileSync(fakeGit, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$PRISM_GIT_CALL_LOG"',
    'case "$1 $2" in',
    '  "rev-parse --is-inside-work-tree") printf "true\\n" ;;',
    '  "rev-parse --show-toplevel") printf "%s\\n" "$PWD" ;;',
    '  "rev-parse --git-dir"|"rev-parse --git-common-dir") printf ".git\\n" ;;',
    '  "rev-parse HEAD") printf "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n" ;;',
    '  "status --porcelain") ;;',
    '  *) exit 1 ;;',
    'esac',
    '/bin/cat "$PRISM_GIT_PAYLOAD" >&2',
    '',
  ].join('\n'));
  fs.chmodSync(fakeGit, 0o755);

  const originalPath = process.env.PATH;
  const originalPayload = process.env.PRISM_GIT_PAYLOAD;
  const originalCallLog = process.env.PRISM_GIT_CALL_LOG;
  try {
    process.env.PATH = fakeBin;
    process.env.PRISM_GIT_PAYLOAD = payload;
    process.env.PRISM_GIT_CALL_LOG = callLog;
    const context = await collectGitContext(repo, 2_000);
    assert.equal(context.status, 'transient_error');
    assert.deepEqual(fs.readFileSync(callLog, 'utf8').trim().split('\n'), [
      'rev-parse --is-inside-work-tree',
      'rev-parse --show-toplevel',
      'rev-parse --git-dir',
      'rev-parse --git-common-dir',
    ]);
  } finally {
    process.env.PATH = originalPath;
    if (originalPayload === undefined) delete process.env.PRISM_GIT_PAYLOAD;
    else process.env.PRISM_GIT_PAYLOAD = originalPayload;
    if (originalCallLog === undefined) delete process.env.PRISM_GIT_CALL_LOG;
    else process.env.PRISM_GIT_CALL_LOG = originalCallLog;
  }
}));

test('preserves the last good git value across consecutive transient refresh failures', () => {
  const dataDir = tempDir('prism-git-state-');
  const sessionId = 'git-last-good';
  const value = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'prompt-git-metadata-v1.json'),
    'utf8',
  ));
  const refreshedAt = '2026-07-16T00:00:00.000Z';
  withDataDir(dataDir, () => {
    const ok = session.writeGit(sessionId, {
      status: 'ok', value, canonicalCwd: '/repo',
      attemptedAt: refreshedAt, refreshedAt, reason: null,
    });
    assert.equal(ok.status, 'ok');
    const failed = session.writeGit(sessionId, {
      status: 'transient_error', value: null, canonicalCwd: '/other',
      attemptedAt: '2026-07-16T00:00:01.000Z', refreshedAt: null, reason: 'git_timeout',
    });
    assert.equal(failed.status, 'transient_error');
    assert.deepEqual(failed.value, value);
    assert.equal(failed.canonicalCwd, '/repo');
    assert.equal(failed.reason, 'git_timeout');
    const retried = session.writeGit(sessionId, {
      status: 'transient_error', value: null, canonicalCwd: '/another-repo',
      attemptedAt: '2026-07-16T00:00:02.000Z', refreshedAt: null, reason: 'git_output_limit',
    });
    assert.equal(retried.status, 'transient_error');
    assert.deepEqual(retried.value, value);
    assert.equal(retried.canonicalCwd, '/repo');
    assert.equal(retried.refreshedAt, refreshedAt);
    assert.equal(retried.reason, 'git_output_limit');
  });
});

test('CwdChanged refreshes only valid runtime hook shapes', () => {
  const repo = makeRepo();
  const dataDir = tempDir('prism-git-handler-');
  const valid = spawnSync(process.execPath, [GIT_HANDLER], {
    cwd: ROOT,
    input: JSON.stringify({ hook_event_name: 'CwdChanged', session_id: 'cwd-valid', new_cwd: repo }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.equal(valid.status, 0, valid.stderr);
  const recorded = withDataDir(dataDir, () => session.readGit('cwd-valid'));
  assert.equal(recorded.status, 'ok');
  const relative = spawnSync(process.execPath, [GIT_HANDLER], {
    cwd: ROOT,
    input: JSON.stringify({
      hook_event_name: 'CwdChanged',
      session_id: 'cwd-valid',
      new_cwd: '../../../repos/prism-plugin',
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.equal(relative.status, 0, relative.stderr);
  assert.deepEqual(withDataDir(dataDir, () => session.readGit('cwd-valid')), recorded);

  const invalid = spawnSync(process.execPath, [GIT_HANDLER], {
    cwd: ROOT,
    input: JSON.stringify({ hook_event_name: 'CwdChanged', session_id: 'cwd-invalid', new_cwd: 7 }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
  });
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(withDataDir(dataDir, () => session.readGit('cwd-invalid')), null);
});
