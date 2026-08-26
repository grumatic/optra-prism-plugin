'use strict';

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
