'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { collectGitContext, classifyTransientReason } = require('../lib/git');
const contract = require('../lib/git-evidence-contract');
const session = require('../lib/session');

const ROOT = path.resolve(__dirname, '..');
const SUBMIT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'submit-handler.js');
const KEY_FILE_NAME = 'git-evidence-install-key-v1';
const DOMAIN = 'prism-git-root/v1\0';
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'prompt-git-metadata-v1.json'), 'utf8'));
const V0_7_8_PAYLOAD_KEYS = [
  'prompt_text', 'source', 'tool_session_id', 'client_event_id',
  'original_char_count', 'untruncated_sha256', 'truncated',
  'cwd', 'host_prompt_id', 'submitted_at',
];
const tempDirs = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(remote) {
  const repo = tempDir('prism-git-meta-');
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  git(repo, ['config', 'user.name', 'Prism Test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'initial\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'initial']);
  if (remote) git(repo, ['remote', 'add', 'origin', remote]);
  return repo;
}

function seedInstallKey(dataDir, key) {
  const keyDir = path.join(dataDir, 'runtime');
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(keyDir, KEY_FILE_NAME), key, { mode: 0o600 });
}

function expectedFingerprint(key, commonDirRealPath) {
  return crypto.createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(DOMAIN, 'utf8'), Buffer.from(commonDirRealPath, 'utf8')]))
    .digest('hex');
}

// The fingerprint is keyed by the Git *common* dir (`<repo>/.git` for a
// plain repository), not the worktree root itself.
function commonDirOf(repo) {
  return fs.realpathSync.native(path.join(repo, '.git'));
}

// Scopes CLAUDE_PLUGIN_DATA to `dataDir` for `action`. The install-key cache
// in lib/git-evidence-contract.js is keyed by installKeyPath() itself, so a
// distinct dataDir per test/withDataDir call already gets a distinct,
// correctly-isolated cache entry with no reset hook required.
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
    return result.then(
      (value) => { restore(); return value; },
      (error) => { restore(); throw error; },
    );
  }
  restore();
  return result;
}

function writeCollectScript(dir) {
  const scriptPath = path.join(dir, 'collect.js');
  const gitLibPath = path.join(ROOT, 'lib', 'git.js');
  fs.writeFileSync(scriptPath, [
    `const { collectGitContext } = require(${JSON.stringify(gitLibPath)});`,
    'collectGitContext(process.argv[2]).then((r) => {',
    '  process.stdout.write((r.value && r.value.root_fingerprint) || "");',
    '});',
    '',
  ].join('\n'));
  return scriptPath;
}

function writePromptMarkerInterceptor(home) {
  const interceptor = path.join(home, 'prompt-interceptor.js');
  fs.writeFileSync(interceptor, [
    "const events = require('node:events');",
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    'http.request = (url, options, callback) => {',
    '  let body = "";',
    '  const request = new events.EventEmitter();',
    '  request.write = (chunk) => { body += chunk; };',
    '  request.destroy = () => {};',
    '  request.end = () => {',
    "    if (url.pathname === '/v1/prompts') fs.writeFileSync(process.env.PRISM_PROMPT_MARKER, body);",
    "    const response = Object.assign(new events.EventEmitter(), { headers: { 'content-type': 'application/json' } });",
    '    response.statusCode = 201;',
    '    callback(response);',
    "    response.emit('data', Buffer.from('{\"id\":\"5e1f8f6e-4b2a-4c3d-9e0f-1a2b3c4d5e6f\"}'));",
    "    response.emit('end');",
    '  };',
    '  return request;',
    '};',
    '',
  ].join('\n'));
  return interceptor;
}

function runSubmitHandler({
  home, dataDir, sessionId, cwd, prompt, marker, pathOverride,
}) {
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config.json'), JSON.stringify({
    apiKey: 'prism_git_metadata_test',
    ingest_url: 'http://127.0.0.1:12345',
  }));
  return spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: sessionId,
      cwd,
      prompt,
      prompt_id: `submit-${sessionId}`,
    }),
    env: {
      ...process.env,
      ...(pathOverride ? { PATH: pathOverride } : {}),
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_PROMPT_MARKER: marker,
      NODE_OPTIONS: `--require=${writePromptMarkerInterceptor(home)}`,
    },
    timeout: 3500,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('sanitizes remote URLs across host/scp/credential/query/local-path forms', () => {
  const cases = [
    ['https://github.com/acme/widget.git', { host: 'github.com', ownerPath: 'acme', owner: 'acme', repo: 'widget' }],
    ['https://user:secret@github.com/acme/widget.git', { host: 'github.com', ownerPath: 'acme', owner: 'acme', repo: 'widget' }],
    ['https://GitHub.com:8443/Acme/Widget.git?token=x#frag', { host: 'github.com', ownerPath: 'Acme', owner: 'Acme', repo: 'Widget' }],
    ['git@github.com:acme/widget.git', { host: 'github.com', ownerPath: 'acme', owner: 'acme', repo: 'widget' }],
    ['ssh://git@gitlab.example:2222/group/sub/project.git', { host: 'gitlab.example', ownerPath: 'group/sub', owner: 'sub', repo: 'project' }],
    ['file:///srv/repos/widget.git', null],
    ['file://nas/srv/repos/widget.git', null],
    ['/srv/repos/widget.git', null],
    ['../peer/widget.git', null],
    ['./x/y/z.git', null],
    ['a/b/c.git', null],
    ['origin', null],
    ['', null],
  ];

  for (const [input, expected] of cases) {
    const result = contract.sanitizeRemoteUrl(input);
    assert.deepEqual(result, expected, input);
    if (result) {
      const serialized = JSON.stringify(result);
      if (input) assert.equal(serialized.includes(input), false, input);
      assert.equal(serialized.includes('secret'), false, input);
      assert.equal(serialized.includes(':2222'), false, input);
      assert.equal(serialized.includes('/srv/repos'), false, input);
    }
  }
});

test('nested GitLab groups report a full owner_path while owner keeps the legacy final-segment rule', () => {
  const result = contract.sanitizeRemoteUrl('https://gitlab.example/a/b/c/d.git');
  assert.deepEqual(result, { host: 'gitlab.example', ownerPath: 'a/b/c', owner: 'c', repo: 'd' });
});

test('classifyTransientReason maps ETIMEDOUT, killed+SIGTERM, and maxBuffer error shapes to their reasons', () => {
  assert.equal(classifyTransientReason(null), null);
  assert.equal(classifyTransientReason({ code: 'ETIMEDOUT' }), 'git_timeout');
  assert.equal(classifyTransientReason({ killed: true, signal: 'SIGTERM' }), 'git_timeout');
  assert.equal(classifyTransientReason({ code: 'EMAXBUFFER' }), 'git_output_limit');
  assert.equal(classifyTransientReason({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), 'git_output_limit');
  // maxBuffer takes precedence even when Node also reports killed + SIGTERM.
  assert.equal(
    classifyTransientReason({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }),
    'git_output_limit',
  );
  assert.equal(classifyTransientReason({ code: 'ENOENT' }), null);
});

test('the root fingerprint is deterministic, worktree-shared, and never leaks a path', async () => {
  const dataDir = tempDir('prism-git-meta-fp-');
  await withDataDir(dataDir, async () => {
    const repoA = makeRepo('https://github.com/acme/widget.git');
    const repoB = makeRepo('https://github.com/acme/other.git');

    const first = await collectGitContext(repoA);
    const second = await collectGitContext(repoA);
    assert.equal(first.value.root_fingerprint, second.value.root_fingerprint);

    const other = await collectGitContext(repoB);
    assert.notEqual(first.value.root_fingerprint, other.value.root_fingerprint);

    git(repoA, ['checkout', '--', 'tracked.txt']);
    const worktree = path.join(path.dirname(repoA), `${path.basename(repoA)}-fp-worktree`);
    git(repoA, ['worktree', 'add', '-b', 'prism-fp-worktree', worktree]);
    tempDirs.push(worktree);
    const worktreeContext = await collectGitContext(worktree);
    assert.equal(worktreeContext.value.root_fingerprint, first.value.root_fingerprint);

    const nested = path.join(repoA, 'nested');
    fs.mkdirSync(nested);
    git(nested, ['init']);
    git(nested, ['config', 'user.email', 'test@example.test']);
    git(nested, ['config', 'user.name', 'Prism Test']);
    fs.writeFileSync(path.join(nested, 'n.txt'), 'n\n');
    git(nested, ['add', 'n.txt']);
    git(nested, ['commit', '-m', 'nested']);
    const nestedContext = await collectGitContext(nested);
    assert.notEqual(nestedContext.value.root_fingerprint, first.value.root_fingerprint);

    const serialized = JSON.stringify(first.value);
    assert.equal(serialized.includes(repoA), false);
    assert.equal(serialized.includes(os.tmpdir()), false);
  });
});

test('the root fingerprint is a keyed HMAC and changes when the install key changes', async () => {
  const repo = makeRepo();
  const commonDirRealPath = commonDirOf(repo);

  const dataDir1 = tempDir('prism-git-meta-keyed-1-');
  const key1 = crypto.randomBytes(32);
  seedInstallKey(dataDir1, key1);
  const fp1 = await withDataDir(dataDir1, async () => (await collectGitContext(repo)).value.root_fingerprint);
  assert.equal(fp1, expectedFingerprint(key1, commonDirRealPath));

  const dataDir2 = tempDir('prism-git-meta-keyed-2-');
  const key2 = crypto.randomBytes(32);
  seedInstallKey(dataDir2, key2);
  const fp2 = await withDataDir(dataDir2, async () => (await collectGitContext(repo)).value.root_fingerprint);
  assert.equal(fp2, expectedFingerprint(key2, commonDirRealPath));

  assert.notEqual(fp1, fp2);
});

test('the install key is created once, reused across process boundaries, and leaves no temp file', () => {
  const dataDir = tempDir('prism-git-meta-create-');
  const repo = makeRepo();
  const script = writeCollectScript(tempDir('prism-git-meta-create-script-'));

  const first = spawnSync(process.execPath, [script, repo], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: 'utf8',
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^[a-f0-9]{64}$/);

  const keyPath = path.join(dataDir, 'runtime', KEY_FILE_NAME);
  const dirPath = path.dirname(keyPath);
  const firstStat = fs.statSync(keyPath);
  assert.equal(firstStat.size, 32);
  assert.equal(firstStat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(dirPath).mode & 0o777, 0o700);
  const firstContent = fs.readFileSync(keyPath);

  const second = spawnSync(process.execPath, [script, repo], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
    encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);

  const secondStat = fs.statSync(keyPath);
  assert.equal(secondStat.ino, firstStat.ino);
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
  assert.deepEqual(fs.readFileSync(keyPath), firstContent);

  const leftoverTemp = fs.readdirSync(dirPath).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftoverTemp, []);
});

test('a corrupt install key degrades to root_key_unavailable without touching the file', async () => {
  for (const size of [31, 0]) {
    const dataDir = tempDir(`prism-git-meta-corrupt-${size}-`);
    seedInstallKey(dataDir, crypto.randomBytes(size));
    const keyPath = path.join(dataDir, 'runtime', KEY_FILE_NAME);
    const before = fs.readFileSync(keyPath);

    await withDataDir(dataDir, async () => {
      const repo = makeRepo('https://github.com/acme/widget.git');
      const context = await collectGitContext(repo);
      assert.equal(context.value.coverage, 'unavailable');
      assert.equal(context.value.reason, 'root_key_unavailable');
      assert.equal('root_fingerprint' in context.value, false);
      assert.equal(context.value.host, 'github.com');
      assert.match(context.value.head, /^[a-f0-9]{40,64}$/);
    });

    assert.deepEqual(fs.readFileSync(keyPath), before);
  }
});

test('an unwritable key directory degrades to root_key_unavailable and leaves no partial file', async () => {
  if (process.getuid && process.getuid() === 0) return;
  const dataDir = tempDir('prism-git-meta-unwritable-');
  const keyDir = path.join(dataDir, 'runtime');
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(keyDir, 0o500);

  try {
    await withDataDir(dataDir, async () => {
      const repo = makeRepo();
      const context = await collectGitContext(repo);
      assert.equal(context.value.coverage, 'unavailable');
      assert.equal(context.value.reason, 'root_key_unavailable');
      assert.equal('root_fingerprint' in context.value, false);
    });
    assert.deepEqual(fs.readdirSync(keyDir), []);
  } finally {
    fs.chmodSync(keyDir, 0o700);
  }
});

test('the worktree flag reflects a linked worktree', async () => {
  const dataDir = tempDir('prism-git-meta-worktree-');
  await withDataDir(dataDir, async () => {
    const repo = makeRepo();
    const plain = await collectGitContext(repo);
    assert.equal(plain.value.worktree, false);

    git(repo, ['checkout', '--', 'tracked.txt']);
    const worktree = path.join(path.dirname(repo), `${path.basename(repo)}-meta-worktree`);
    git(repo, ['worktree', 'add', '-b', 'prism-meta-worktree', worktree]);
    tempDirs.push(worktree);
    const linked = await collectGitContext(worktree);
    assert.equal(linked.value.worktree, true);
  });
});

test('a non-repository directory yields the not_repository envelope reason', async () => {
  const plain = tempDir('prism-git-meta-plain-');
  const context = await collectGitContext(plain);
  assert.equal(context.status, 'not_repo');
  assert.equal(context.value, null);
  assert.equal(context.reason, 'not_repository');

  const wire = contract.unavailablePromptGitMetadata(context.reason, context.attemptedAt);
  assert.deepEqual(Object.keys(wire), ['schema_version', 'observed_at', 'coverage', 'reason']);
  assert.equal(wire.coverage, 'unavailable');
  assert.equal(wire.reason, 'not_repository');
});

test('a git timeout from a mid-command kill classifies as git_timeout', async () => {
  const repo = makeRepo();

  // execFile's own `timeout` option kills a still-running command with
  // SIGTERM; Node does not reliably set error.code to 'ETIMEDOUT' for that
  // path, so classification must also accept killed + SIGTERM (the shape
  // this fake, deliberately slow git actually produces).
  const fakeBin = tempDir('prism-git-meta-slow-');
  const fakeGit = path.join(fakeBin, 'git');
  fs.writeFileSync(fakeGit, '#!/bin/sh\n/bin/sleep 1\n');
  fs.chmodSync(fakeGit, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = fakeBin;
    const killed = await collectGitContext(repo, 100);
    assert.equal(killed.status, 'transient_error');
    assert.equal(killed.reason, 'git_timeout');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('output budget exhaustion accumulated across commands classifies as git_output_limit', async () => {
  const repo = makeRepo();
  const fakeBin = tempDir('prism-git-meta-output-budget-bin-');
  const payload = path.join(fakeBin, 'payload');
  const fakeGit = path.join(fakeBin, 'git');
  fs.writeFileSync(payload, 'x'.repeat(20 * 1024));
  fs.writeFileSync(fakeGit, [
    '#!/bin/sh',
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
  try {
    process.env.PATH = fakeBin;
    process.env.PRISM_GIT_PAYLOAD = payload;
    const context = await collectGitContext(repo, 2_000);
    assert.equal(context.status, 'transient_error');
    assert.equal(context.reason, 'git_output_limit');
  } finally {
    process.env.PATH = originalPath;
    if (originalPayload === undefined) delete process.env.PRISM_GIT_PAYLOAD;
    else process.env.PRISM_GIT_PAYLOAD = originalPayload;
  }
});

test('a single command exceeding the output budget in one shot also classifies as git_output_limit', async () => {
  const repo = makeRepo();
  const fakeBin = tempDir('prism-git-meta-single-maxbuffer-');
  const fakeGit = path.join(fakeBin, 'git');
  fs.writeFileSync(fakeGit, [
    '#!/bin/sh',
    'case "$1 $2" in',
    // Absolute paths: PATH is overridden to fakeBin alone for this test.
    '  "rev-parse --is-inside-work-tree") /usr/bin/head -c 200000 /dev/zero | /usr/bin/tr "\\0" x ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(fakeGit, 0o755);

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = fakeBin;
    const context = await collectGitContext(repo, 2_000);
    assert.equal(context.status, 'transient_error');
    assert.equal(context.reason, 'git_output_limit');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('coverage precedence: a missing remote yields remote_missing, but a broken key still outranks it', async () => {
  const repoWithoutRemote = makeRepo();

  const goodKeyDataDir = tempDir('prism-git-meta-precedence-good-');
  await withDataDir(goodKeyDataDir, async () => {
    const context = await collectGitContext(repoWithoutRemote);
    assert.equal(context.value.coverage, 'unavailable');
    assert.equal(context.value.reason, 'remote_missing');
    assert.match(context.value.head, /^[a-f0-9]{40,64}$/);
    assert.equal('root_fingerprint' in context.value, true);
    assert.equal(context.value.host, null);
    assert.equal(context.value.owner, null);
    assert.equal(context.value.repo, null);
    assert.equal('owner_path' in context.value, false);
  });

  const corruptKeyDataDir = tempDir('prism-git-meta-precedence-corrupt-');
  seedInstallKey(corruptKeyDataDir, Buffer.alloc(0));
  await withDataDir(corruptKeyDataDir, async () => {
    const context = await collectGitContext(repoWithoutRemote);
    assert.equal(context.value.coverage, 'unavailable');
    assert.equal(context.value.reason, 'root_key_unavailable');
    assert.equal('root_fingerprint' in context.value, false);
  });
});

test('the built object matches the golden fixture and round-trips as plain JSON', () => {
  const remote = contract.sanitizeRemoteUrl('https://github.com/example-org/example-group/example-repo.git');
  const built = contract.buildPromptGitMetadata({
    observedAt: fixture.observed_at,
    remote,
    branch: fixture.branch,
    head: fixture.head,
    dirty: fixture.dirty,
    worktree: fixture.worktree,
    rootFingerprint: fixture.root_fingerprint,
  });

  assert.deepEqual(built, fixture);
  assert.deepEqual(Object.keys(built), Object.keys(fixture));

  const roundTripped = JSON.parse(JSON.stringify(built));
  assert.deepEqual(roundTripped, built);
  for (const value of Object.values(built)) {
    assert.notEqual(value, undefined);
    assert.equal(value !== null && typeof value === 'object', false);
  }
  assert.ok([contract.PROMPT_GIT_COVERAGE_READY, contract.PROMPT_GIT_COVERAGE_UNAVAILABLE].includes(built.coverage));
  assert.ok(built.reason === undefined || contract.PROMPT_GIT_REASONS.includes(built.reason));
});

test('session.writeGit accepts a v1 value and rejects a v0.7.8-shaped one', () => {
  const dataDir = tempDir('prism-git-meta-session-');
  const sessionId = 'git-meta-session-shape';
  withDataDir(dataDir, () => {
    const accepted = session.writeGit(sessionId, {
      status: 'ok', value: fixture, canonicalCwd: '/repo',
      attemptedAt: fixture.observed_at, refreshedAt: fixture.observed_at, reason: null,
    });
    assert.equal(accepted.status, 'ok');
    assert.deepEqual(accepted.value, fixture);

    const legacyValue = {
      host: 'github.com', owner: 'acme', repo: 'widget', branch: 'main',
      head: 'a'.repeat(40), dirty: false, worktree: false,
    };
    const rejected = session.writeGit(sessionId, {
      status: 'ok', value: legacyValue, canonicalCwd: '/repo',
      attemptedAt: new Date().toISOString(), refreshedAt: new Date().toISOString(), reason: null,
    });
    assert.equal(rejected, null);
  });
});

test('a pre-existing v0.7.8 git record makes readGit return null so the submit path collects fresh', () => {
  const dataDir = tempDir('prism-git-meta-legacy-record-');
  const sessionId = 'legacy-git-record';
  const sessionDir = path.join(
    dataDir, 'runtime', 'sessions',
    crypto.createHash('sha256').update(sessionId).digest('hex'),
  );
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const legacyRecord = {
    schemaVersion: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    generation: 1,
    status: 'ok',
    value: {
      host: 'github.com', owner: 'acme', repo: 'widget', branch: 'main',
      head: 'a'.repeat(40), dirty: false, worktree: false,
    },
    canonicalCwd: '/repo',
    attemptedAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(sessionDir, 'git.g1.f1.json'), JSON.stringify(legacyRecord), { mode: 0o600 });

  withDataDir(dataDir, () => {
    assert.equal(session.readGit(sessionId), null);
  });
});

test('this slice adds no evidence-outbox surface and stays isolated in its own strings', () => {
  for (const forbidden of ['lib/git-evidence-outbox.js', 'lib/git-evidence-delivery.js', 'lib/git-evidence-capability.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, forbidden)), false, forbidden);
  }

  const offenders = [];
  for (const dir of ['lib', 'hooks', 'test']) {
    const files = [];
    (function walk(current) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    })(path.join(ROOT, dir));
    for (const file of files) {
      // This guard test itself legitimately names the forbidden strings as
      // assertion literals; every other file must stay free of them.
      if (file === __filename) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('/v1/git-evidence') || source.includes('git-evidence/v1')) {
        offenders.push(path.relative(ROOT, file));
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('git binary absent from PATH omits metadata.git entirely and still captures the prompt (fail-open)', () => {
  const home = tempDir('prism-git-meta-nogit-home-');
  const dataDir = tempDir('prism-git-meta-nogit-data-');
  const marker = path.join(home, 'prompt.json');
  const missingBin = tempDir('prism-git-meta-missing-bin-');

  const result = runSubmitHandler({
    home,
    dataDir,
    sessionId: 'no-git-session',
    cwd: ROOT,
    prompt: 'prompt without a git binary available',
    marker,
    pathOverride: missingBin,
  });

  assert.equal(result.status, 0, result.stderr);
  const sent = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal('metadata' in sent, false);
  assert.deepEqual(Object.keys(sent).sort(), [...V0_7_8_PAYLOAD_KEYS].sort());
});

test('a timed-out git still captures the prompt and attaches the unavailable variant with git_timeout', () => {
  const home = tempDir('prism-git-meta-timeout-home-');
  const dataDir = tempDir('prism-git-meta-timeout-data-');
  const marker = path.join(home, 'prompt.json');
  const slowBin = tempDir('prism-git-meta-timeout-bin-');
  const slowGit = path.join(slowBin, 'git');
  fs.writeFileSync(slowGit, '#!/bin/sh\n/bin/sleep 1\n');
  fs.chmodSync(slowGit, 0o755);

  const result = runSubmitHandler({
    home,
    dataDir,
    sessionId: 'timeout-git-session',
    cwd: ROOT,
    prompt: 'prompt with a hanging git binary',
    marker,
    pathOverride: slowBin,
  });

  assert.equal(result.status, 0, result.stderr);
  const sent = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.deepEqual(Object.keys(sent).sort(), [...V0_7_8_PAYLOAD_KEYS, 'metadata'].sort());
  assert.deepEqual(Object.keys(sent.metadata), ['git']);
  assert.deepEqual(sent.metadata.git, {
    schema_version: 'prompt-git-metadata/v1',
    observed_at: sent.metadata.git.observed_at,
    coverage: 'unavailable',
    reason: 'git_timeout',
  });
  assert.ok(Number.isFinite(Date.parse(sent.metadata.git.observed_at)));
});
