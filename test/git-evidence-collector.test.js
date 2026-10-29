'use strict';

require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { collectCommittedRange, collectFinalGitState } = require('../lib/git');

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
  const repo = tempDir('prism-git-evidence-collector-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  git(repo, ['config', 'user.name', 'Prism Test']);
  return repo;
}

function commit(repo, file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test('a linear range yields commits with correct line counts and a ready coverage', async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  commit(repo, 'a.txt', 'one\ntwo\n', 'c2');
  const final = commit(repo, 'a.txt', 'one\ntwo\nthree\n', 'c3');

  const range = await collectCommittedRange({ cwd: repo, baselineHead: baseline, finalHead: final });
  assert.equal(range.ancestry, 'linear');
  assert.equal(range.coverage, 'ready');
  assert.equal(range.reason, null);
  assert.equal(range.commits.length, 2);
  assert.equal(range.commits[0].parentSha, baseline);
  assert.equal(range.commits[1].parentSha, range.commits[0].commitSha);
  assert.equal(range.commits[1].commitSha, final);
  assert.equal(range.commits[0].addedLines, 1);
  assert.equal(range.commits[1].addedLines, 1);
});

test('baselineHead === finalHead yields an empty ready range', async () => {
  const repo = makeRepo();
  const head = commit(repo, 'a.txt', 'one\n', 'c1');
  const range = await collectCommittedRange({ cwd: repo, baselineHead: head, finalHead: head });
  assert.equal(range.coverage, 'ready');
  assert.deepEqual(range.commits, []);
});

test('a filename with a space, a newline, and non-ASCII text parses correctly and never appears in the payload', async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'seed\n', 'seed');
  const weirdName = 'weird file\nname 안녕.txt';
  fs.writeFileSync(path.join(repo, weirdName), 'content\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'add weird file']);
  const final = git(repo, ['rev-parse', 'HEAD']);

  const range = await collectCommittedRange({ cwd: repo, baselineHead: baseline, finalHead: final });
  assert.equal(range.coverage, 'ready');
  assert.equal(range.commits.length, 1);
  assert.equal(range.commits[0].addedLines, 1);
  assert.ok(!JSON.stringify(range).includes('weird'));
});

test('a binary file increments excludedBinaryCount, contributes zero lines, and keeps coverage ready', async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'seed\n', 'seed');
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 254]));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'add binary']);
  const final = git(repo, ['rev-parse', 'HEAD']);

  const range = await collectCommittedRange({ cwd: repo, baselineHead: baseline, finalHead: final });
  assert.equal(range.coverage, 'ready');
  assert.equal(range.excludedBinaryCount, 1);
  assert.equal(range.commits[0].addedLines, 0);
  assert.equal(range.commits[0].deletedLines, 0);
});

test('git_non_ancestor_v1: an unrelated branch is reported as non_ancestor with no commits and no LoC', async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'seed\n', 'seed');
  git(repo, ['checkout', '-q', '--orphan', 'other']);
  git(repo, ['rm', '-rf', '-q', '.']);
  const final = commit(repo, 'b.txt', 'unrelated\n', 'unrelated');

  const range = await collectCommittedRange({ cwd: repo, baselineHead: baseline, finalHead: final });
  assert.equal(range.ancestry, 'non_ancestor');
  assert.equal(range.coverage, 'partial');
  assert.equal(range.reason, 'non_ancestor');
  assert.deepEqual(range.commits, []);
  assert.ok(!JSON.stringify(range).match(/added|deleted/i) || range.commits.length === 0);
});

test('a range beyond the commit limit reports commit_limit_exceeded with empty commits', async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', '0\n', 'seed');
  let final = baseline;
  for (let i = 1; i <= 5; i += 1) {
    final = commit(repo, 'a.txt', `${i}\n`, `c${i}`);
  }
  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, commitLimit: 3,
  });
  assert.equal(range.coverage, 'unavailable');
  assert.equal(range.reason, 'commit_limit_exceeded');
  assert.deepEqual(range.commits, []);
});

test('an exhausted deadline reports final_snapshot_failed with empty commits', async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', '0\n', 'seed');
  const final = commit(repo, 'a.txt', '1\n', 'c1');
  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, deadlineMs: 1,
  });
  assert.equal(range.coverage, 'unavailable');
  assert.equal(range.reason, 'final_snapshot_failed');
  assert.deepEqual(range.commits, []);
});

test('uncommitted_excluded_v1: dirty is true but line totals match a clean-tree run', async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', '0\n', 'seed');
  const final = commit(repo, 'a.txt', '0\n1\n', 'c1');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'scratch\n');
  fs.appendFileSync(path.join(repo, 'a.txt'), '2\n');

  const finalState = await collectFinalGitState(repo);
  assert.equal(finalState.status, 'ok');
  assert.equal(finalState.dirty, true);

  const range = await collectCommittedRange({ cwd: repo, baselineHead: baseline, finalHead: final });
  assert.equal(range.coverage, 'ready');
  assert.equal(range.commits[0].addedLines, 1);
});

test('collectFinalGitState reports not_repo outside a work tree', async () => {
  const dir = tempDir('prism-not-a-repo-');
  const state = await collectFinalGitState(dir);
  assert.equal(state.status, 'not_repo');
});

test('final_snapshot_failed: the repository directory is removed between prompt and Stop', async () => {
  const repo = makeRepo();
  commit(repo, 'a.txt', '0\n', 'seed');
  fs.rmSync(repo, { recursive: true, force: true });
  tempDirs.splice(tempDirs.indexOf(repo), 1);
  const state = await collectFinalGitState(repo);
  assert.notEqual(state.status, 'ok');
});

test('a merge commit is measured against its first parent only, and that first parent is the real Git parent, not a synthesized chain link', async () => {
  const repo = makeRepo();
  const root = commit(repo, 'base.txt', 'base\n', 'base');
  git(repo, ['checkout', '-q', '-b', 'topic']);
  // The baseline for this capture sits ON the topic branch — i.e. the
  // prompt-phase snapshot was taken while cwd pointed at topic's tip. The
  // repository then moves on independently: checkout back to a mainline
  // branch (never touching topic again) and merge topic into it.
  const topicHead = commit(repo, 'topic.txt', 'topic\n', 'topic-change');
  git(repo, ['checkout', '-q', '-b', 'main-line', root]);
  const mainlineHead = commit(repo, 'mainline.txt', 'mainline\n', 'mainline-change');
  git(repo, ['merge', '-q', '--no-ff', 'topic', '-m', 'merge']);
  const mergeSha = git(repo, ['rev-parse', 'HEAD']);
  const final = commit(repo, 'after.txt', 'after\n', 'after-merge');

  // baselineHead is topicHead, NOT mainlineHead: root is reachable from
  // topicHead (topic branched from it) but mainlineHead is not — so the
  // first-parent walk from final, excluded by topicHead's ancestry, still
  // includes mainlineHead itself. This is exactly the "baseline reachable
  // only via a second parent" case B1 describes: merge-base --is-ancestor
  // (topicHead, final) is true only via the merge commit's SECOND parent.
  const range = await collectCommittedRange({ cwd: repo, baselineHead: topicHead, finalHead: final });
  assert.equal(range.ancestry, 'linear');
  assert.equal(range.coverage, 'ready');
  assert.equal(range.commits.length, 3);

  const [mainlineCommit, mergeCommit, afterCommit] = range.commits;
  assert.equal(mainlineCommit.commitSha, mainlineHead);
  // The old synthesized chain (parentOf(shas[0]) = baselineHead) would have
  // wrongly claimed this first commit's parent is topicHead. Its real first
  // (and only) parent is root.
  assert.equal(mainlineCommit.parentSha, root);
  assert.notEqual(mainlineCommit.parentSha, topicHead);

  assert.equal(mergeCommit.commitSha, mergeSha);
  // The merge's real first parent is the mainline tip — never topicHead
  // (what the old synthesized chain would report for a first-list-item
  // merge commit in other topologies) and never a made-up chain link.
  assert.equal(mergeCommit.parentSha, mainlineHead);
  assert.notEqual(mergeCommit.parentSha, topicHead);
  assert.equal(afterCommit.parentSha, mergeSha);
});

test('a submodule (gitlink) change increments excluded_submodule_count while coverage stays ready', async () => {
  const submoduleSource = makeRepo();
  commit(submoduleSource, 'lib.txt', 'lib\n', 'submodule seed');

  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'seed\n', 'seed');
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleSource, 'sub']);
  git(repo, ['commit', '-q', '-m', 'add submodule']);
  const final = git(repo, ['rev-parse', 'HEAD']);

  const range = await collectCommittedRange({ cwd: repo, baselineHead: baseline, finalHead: final });
  assert.equal(range.coverage, 'ready');
  assert.equal(range.excludedSubmoduleCount, 1);
});

// ─── git-evidence/v2 author verdicts ───

// Points global Git config at an empty (or given) file, disables system
// config, and clears the author-email environment, so a developer's own
// identity cannot decide a verdict. Both the fixture commands and the
// collector read process.env.
async function withIsolatedGitConfig(action, globalConfig = '') {
  const file = path.join(tempDir('prism-git-evidence-global-'), 'gitconfig');
  fs.writeFileSync(file, globalConfig);
  const overrides = {
    GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_EMAIL: undefined, EMAIL: undefined,
  };
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Sets one environment variable for the collector call only, after the
// fixture commits were made without it.
async function withEnvValue(key, value, action) {
  process.env[key] = value;
  try {
    return await action();
  } finally {
    delete process.env[key];
  }
}

function commitAs(repo, email, file, content, message) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ['add', '.']);
  git(repo, ['-c', `user.email=${email}`, 'commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function verdicts(range) {
  return range.commits.map((item) => item.authorFilter);
}

test('git_evidence_v2: without judgeAuthors the range carries no verdict and no filter', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  const final = commitAs(repo, 'peer@example.test', 'a.txt', 'one\ntwo\n', 'c2');

  const range = await collectCommittedRange({ cwd: repo, baselineHead: baseline, finalHead: final });
  assert.equal(Object.hasOwn(range, 'foreignCommitFilter'), false);
  assert.equal(Object.hasOwn(range.commits[0], 'authorFilter'), false);
  assert.equal(range.commits[0].parentCount, 1);
}));

test('git_evidence_v2: without judgeAuthors the Git calls are exactly the v1 sequence', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  commit(repo, 'a.txt', 'one\ntwo\n', 'c2');
  const final = commit(repo, 'a.txt', 'one\ntwo\nthree\n', 'c3');

  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const fakeBin = tempDir('prism-git-evidence-call-log-');
  const callLog = path.join(fakeBin, 'calls');
  fs.writeFileSync(path.join(fakeBin, 'git'), [
    '#!/bin/sh',
    `printf "%s\\n" "$*" >> "${callLog}"`,
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  const originalPath = process.env.PATH;
  const calls = async (options) => {
    fs.rmSync(callLog, { force: true });
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
    try {
      await collectCommittedRange({
        cwd: repo, baselineHead: baseline, finalHead: final, ...options,
      });
    } finally {
      process.env.PATH = originalPath;
    }
    return fs.readFileSync(callLog, 'utf8').trim().split('\n');
  };

  const [first, second] = git(repo, ['rev-list', '--reverse', `${baseline}..${final}`]).split('\n');
  const v1Calls = [
    'rev-parse --is-inside-work-tree',
    `merge-base --is-ancestor ${baseline} ${final}`,
    `rev-list --first-parent --parents --reverse ${baseline}..${final}`,
    `diff --numstat -z --no-renames --ignore-submodules=all ${baseline} ${first}`,
    `diff --numstat -z --no-renames --ignore-submodules=all ${first} ${second}`,
    `diff --raw -z --no-renames ${baseline} ${final}`,
  ];
  assert.deepEqual(await calls({}), v1Calls);

  // v2 adds only the author-identity lookup and the rev-list format.
  const v2Calls = await calls({ judgeAuthors: true });
  assert.deepEqual(v2Calls, [
    'rev-parse --is-inside-work-tree',
    'var GIT_AUTHOR_IDENT',
    `merge-base --is-ancestor ${baseline} ${final}`,
    `rev-list --first-parent --parents --reverse --format=%x01%ae ${baseline}..${final}`,
    ...v1Calls.slice(3),
  ]);
}));

test('git_evidence_v2: a stalled author lookup costs only the verdict, never the committed range', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  const final = commit(repo, 'a.txt', 'one\ntwo\n', 'c2');

  // `git var` hangs, as a slow host-name resolver would make it.
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const fakeBin = tempDir('prism-git-evidence-slow-var-');
  fs.writeFileSync(path.join(fakeBin, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "var" ]; then exec sleep 10; fi',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  let range;
  try {
    range = await collectCommittedRange({
      cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
    });
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(range.coverage, 'ready');
  assert.equal(range.commits.length, 1);
  assert.equal(range.foreignCommitFilter, 'unavailable');
  assert.equal(Object.hasOwn(range.commits[0], 'authorFilter'), false);
}));

test('git_evidence_v2: a fast-forwarded teammate commit is foreign and only that commit', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'mine-1');
  commitAs(repo, 'peer@example.test', 'a.txt', 'one\ntwo\n', 'theirs');
  const final = commit(repo, 'a.txt', 'one\ntwo\nthree\n', 'mine-2');

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.equal(range.foreignCommitFilter, 'applied');
  assert.deepEqual(verdicts(range), ['foreign', 'own']);
  assert.equal(range.coverage, 'ready');
}));

test('git_evidence_v2: the configured email is compared after Git\'s own cleanup', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  // Git drops a trailing '.' when it records an identity.
  git(repo, ['config', 'user.email', 'test@example.test.']);
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  const final = commit(repo, 'a.txt', 'one\ntwo\n', 'c2');

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.deepEqual(verdicts(range), ['own']);
}));

test('git_evidence_v2: an email that differs only in case and surrounding space is own', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  git(repo, ['config', 'user.email', '  Test@Example.TEST ']);
  const baseline = commitAs(repo, 'test@example.test', 'a.txt', 'one\n', 'c1');
  const final = commitAs(repo, 'TEST@example.test', 'a.txt', 'one\ntwo\n', 'c2');

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.deepEqual(verdicts(range), ['own']);
}));

test('git_evidence_v2: an empty author email is foreign and never shifts a later commit', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  commitAs(repo, '', 'a.txt', 'one\ntwo\n', 'empty-middle');
  commit(repo, 'a.txt', 'one\ntwo\nthree\n', 'mine');
  const final = commitAs(repo, '', 'a.txt', 'one\ntwo\nthree\nfour\n', 'empty-last');

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.deepEqual(verdicts(range), ['foreign', 'own', 'foreign']);
  assert.deepEqual(range.commits.map((item) => item.parentCount), [1, 1, 1]);
  assert.equal(range.commits[2].commitSha, final);
}));

test('git_evidence_v2: an author email shaped like a rev-list header is parsed as an email', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  commitAs(repo, `commit ${'a'.repeat(40)}`, 'a.txt', 'one\ntwo\n', 'header-shaped');
  const final = commit(repo, 'a.txt', 'one\ntwo\nthree\n', 'mine');

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.equal(range.commits.length, 2);
  assert.deepEqual(verdicts(range), ['foreign', 'own']);
}));

test('git_evidence_v2: author.email takes precedence over user.email', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  commit(repo, 'a.txt', 'one\ntwo\n', 'as-user-email');
  // Git itself records author.email over user.email from here on.
  git(repo, ['config', 'author.email', 'author@example.test']);
  const final = commit(repo, 'a.txt', 'one\ntwo\nthree\n', 'as-author-email');

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.deepEqual(verdicts(range), ['foreign', 'own']);
}));

test('git_evidence_v2: GIT_AUTHOR_EMAIL takes precedence over author.email and user.email', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  git(repo, ['config', 'author.email', 'author@example.test']);
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  const final = commitAs(repo, 'session@example.test', 'a.txt', 'one\ntwo\n', 'by-session-env');

  const range = await withEnvValue('GIT_AUTHOR_EMAIL', 'Session@Example.test', () => collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  }));
  // The fixture commit was authored by author.email (config wins over -c
  // user.email), so it is foreign to the session's GIT_AUTHOR_EMAIL.
  assert.equal(range.foreignCommitFilter, 'applied');
  assert.deepEqual(verdicts(range), ['foreign']);
}));

test('git_evidence_v2: EMAIL is the last fallback when no author email is configured', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  const final = commitAs(repo, 'fallback@example.test', 'a.txt', 'one\ntwo\n', 'c2');
  git(repo, ['config', '--unset', 'user.email']);

  const range = await withEnvValue('EMAIL', 'fallback@example.test', () => collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  }));
  assert.equal(range.foreignCommitFilter, 'applied');
  assert.deepEqual(verdicts(range), ['own']);
}));

test('git_evidence_v2: when Git cannot determine an author email the filter is unavailable and no commit carries a verdict', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  const final = commit(repo, 'a.txt', 'one\ntwo\n', 'c2');
  git(repo, ['config', '--unset', 'user.email']);
  // Without it Git may fall back to an email guessed from the host name,
  // which would be compared like any other.
  git(repo, ['config', 'user.useConfigOnly', 'true']);

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.equal(range.foreignCommitFilter, 'unavailable');
  assert.equal(range.commits.length, 1);
  assert.equal(Object.hasOwn(range.commits[0], 'authorFilter'), false);
  assert.equal(range.commits[0].parentCount, 1);
}));

test('git_evidence_v2: an includeIf email applies', async () => {
  const repo = makeRepo();
  git(repo, ['config', '--unset', 'user.email']);
  const included = path.join(tempDir('prism-git-evidence-include-'), 'work.gitconfig');
  fs.writeFileSync(included, '[user]\n\temail = work@example.test\n');
  const globalConfig = `[includeIf "gitdir:${fs.realpathSync(repo)}/"]\n\tpath = ${included}\n`;

  await withIsolatedGitConfig(async () => {
    const baseline = commitAs(repo, 'work@example.test', 'a.txt', 'one\n', 'c1');
    commitAs(repo, 'peer@example.test', 'a.txt', 'one\ntwo\n', 'theirs');
    const final = commitAs(repo, 'work@example.test', 'a.txt', 'one\ntwo\nthree\n', 'mine');

    const range = await collectCommittedRange({
      cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
    });
    assert.equal(range.foreignCommitFilter, 'applied');
    assert.deepEqual(verdicts(range), ['foreign', 'own']);
  }, globalConfig);
});

test('git_evidence_v2: a merge commit counts two parents and a plain commit one', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'base.txt', 'base\n', 'base');
  git(repo, ['checkout', '-q', '-b', 'topic']);
  commitAs(repo, 'peer@example.test', 'topic.txt', 'topic\n', 'topic-change');
  git(repo, ['checkout', '-q', '-']);
  commit(repo, 'mainline.txt', 'mainline\n', 'mainline-change');
  git(repo, ['merge', '-q', '--no-ff', 'topic', '-m', 'merge']);
  const final = git(repo, ['rev-parse', 'HEAD']);

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  assert.deepEqual(range.commits.map((item) => item.parentCount), [1, 2]);
  assert.deepEqual(verdicts(range), ['own', 'own']);
}));

test('git_evidence_v2: every range outcome carries the filter, including empty and non-ancestor ranges', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const head = commit(repo, 'a.txt', 'one\n', 'c1');
  const empty = await collectCommittedRange({
    cwd: repo, baselineHead: head, finalHead: head, judgeAuthors: true,
  });
  assert.equal(empty.foreignCommitFilter, 'applied');
  assert.deepEqual(empty.commits, []);

  git(repo, ['checkout', '-q', '--orphan', 'unrelated']);
  const unrelated = commit(repo, 'b.txt', 'two\n', 'unrelated');
  const nonAncestor = await collectCommittedRange({
    cwd: repo, baselineHead: head, finalHead: unrelated, judgeAuthors: true,
  });
  assert.equal(nonAncestor.reason, 'non_ancestor');
  assert.equal(nonAncestor.foreignCommitFilter, 'applied');

  const outside = await collectCommittedRange({
    cwd: tempDir('prism-git-evidence-outside-'), baselineHead: head, finalHead: head, judgeAuthors: true,
  });
  assert.equal(outside.reason, 'final_snapshot_failed');
  assert.equal(outside.foreignCommitFilter, 'unavailable');
}));

test('git_evidence_v2: no email reaches the returned range', () => withIsolatedGitConfig(async () => {
  const repo = makeRepo();
  const baseline = commit(repo, 'a.txt', 'one\n', 'c1');
  const final = commitAs(repo, 'peer@example.test', 'a.txt', 'one\ntwo\n', 'c2');

  const range = await collectCommittedRange({
    cwd: repo, baselineHead: baseline, finalHead: final, judgeAuthors: true,
  });
  const serialized = JSON.stringify(range);
  assert.equal(serialized.includes('example.test'), false);
  assert.equal(serialized.includes('@'), false);
}));
