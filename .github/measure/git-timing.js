'use strict';

// TEMPORARY: measures, without suite load, how long the prompt-path Git
// sequences take in a fresh Node process (as a hook runs) and in a warm one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const LONG_MS = 10000;
const COLD_RUNS = 40;
const WARM_RUNS = 20;

async function measureOnce(repo, worktree, at) {
  const git = require(path.join(ROOT, 'lib', 'git.js'));
  let started = Date.now();
  const context = await git.collectGitContext(repo, LONG_MS);
  const collect = Date.now() - started;

  started = Date.now();
  const deadlineAt = Date.now() + LONG_MS;
  const root = await git.resolveWorktreeRoot(worktree, LONG_MS, { deadlineAt });
  const head = root ? await git.resolveHeadAt(root, at, { fallbackToCurrent: false, deadlineAt }) : null;
  const stop = Date.now() - started;
  return { collect, status: context.status, stop, stopFound: Boolean(head) };
}

function stats(label, values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const over = (limit) => sorted.filter((value) => value > limit).length;
  console.log(`${label}: n=${sorted.length} min=${sorted[0]} p50=${pick(0.5)} p90=${pick(0.9)} max=${sorted[sorted.length - 1]}`
    + ` over250=${over(250)} over1000=${over(1000)}`);
}

async function main() {
  if (process.argv[2] === 'child') {
    console.log(JSON.stringify(await measureOnce(process.argv[3], process.argv[4], process.argv[5])));
    return;
  }

  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'measure-git-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Measure', GIT_AUTHOR_EMAIL: 'measure@example.test',
    GIT_COMMITTER_NAME: 'Measure', GIT_COMMITTER_EMAIL: 'measure@example.test',
  };
  const git = (args, cwd = repo) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'initial\n');
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial']);
  git(['remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
  const worktree = path.join(repo, '.claude', 'worktrees', 'measure');
  git(['worktree', 'add', '-q', '-b', 'worktree-measure', worktree]);
  const at = new Date(Date.now() + 5000).toISOString();

  console.log(`platform=${process.platform} node=${process.version} git=${git(['--version'])}`);

  const single = [];
  for (let index = 0; index < COLD_RUNS; index += 1) {
    const started = Date.now();
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env });
    single.push(Date.now() - started);
  }
  stats('one git command (execFileSync)', single);

  const cold = [];
  for (let index = 0; index < COLD_RUNS; index += 1) {
    const result = spawnSync(process.execPath, [__filename, 'child', repo, worktree, at], { env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`child failed: ${result.stderr}`);
    cold.push(JSON.parse(result.stdout));
  }
  stats('cold prompt snapshot, 7 commands', cold.map((item) => item.collect));
  stats('cold Stop root + reflog', cold.map((item) => item.stop));
  console.log(`cold statuses: ${JSON.stringify(cold.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {}))}`
    + ` stopFound=${cold.filter((item) => item.stopFound).length}`);

  const warm = [];
  for (let index = 0; index < WARM_RUNS; index += 1) warm.push(await measureOnce(repo, worktree, at));
  stats('warm prompt snapshot, 7 commands', warm.map((item) => item.collect));
  stats('warm Stop root + reflog', warm.map((item) => item.stop));

  fs.rmSync(base, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
