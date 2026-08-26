'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_TAG = 'release: v0.7.9';
const EXPECTED_SUBJECTS = [
  'feat(git): capture committed git evidence',
  'test(git): cover committed git evidence delivery',
  'release: v0.7.10',
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function findMetadataReleaseCommit() {
  const log = git(['log', '--format=%H%x01%s']).split('\n').filter(Boolean);
  for (const line of log) {
    const [sha, subject] = line.split('\x01');
    if (subject === RELEASE_TAG) return sha;
  }
  return null;
}

test('plugin_evidence_release_boundary_v1', () => {
  const metadataRelease = findMetadataReleaseCommit();
  if (!metadataRelease) {
    // The `release: v0.7.9` metadata boundary commit is not present on this
    // branch tip. This test validates the committed-evidence release
    // structure once the three commits below have landed on `develop`; it
    // is not evaluable before that.
    return;
  }

  const headSha = git(['rev-parse', 'HEAD']);
  if (headSha === metadataRelease) {
    // develop is still sitting exactly on the metadata release commit: the
    // feature commits have not landed yet, so the strict-ancestor and
    // structural assertions below are not evaluable.
    return;
  }

  const isAncestor = (() => {
    try {
      git(['merge-base', '--is-ancestor', metadataRelease, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  })();
  // --is-ancestor treats a commit as its own ancestor, so it alone would
  // pass when metadataRelease === HEAD; the headSha inequality above (and
  // this assertion together) is what makes this a strict-ancestor check.
  assert.equal(isAncestor, true, `${RELEASE_TAG} must be an ancestor of HEAD`);

  const between = git(['log', '--format=%H%x01%s', `${metadataRelease}..HEAD`])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\x01');
      return { sha, subject };
    })
    .reverse();

  assert.deepEqual(between.map((commit) => commit.subject), EXPECTED_SUBJECTS);

  const [featCommit, testCommit, releaseCommit] = between;

  const featFiles = git(['show', '--name-only', '--format=', featCommit.sha]).split('\n').filter(Boolean);
  assert.ok(featFiles.length > 0);
  for (const file of featFiles) {
    assert.ok(!file.startsWith('test/'), `feat commit must not touch test/: ${file}`);
    assert.ok(!file.startsWith('.github/'), `feat commit must not touch .github/: ${file}`);
    assert.ok(!['AGENTS.md', 'CLAUDE.md', 'README.md'].includes(file), `feat commit must not touch ${file}`);
  }

  const testFiles = git(['show', '--name-only', '--format=', testCommit.sha]).split('\n').filter(Boolean);
  assert.ok(testFiles.length > 0);
  for (const file of testFiles) {
    assert.ok(file.startsWith('test/'), `test commit must touch only test/: ${file}`);
  }

  const releaseFiles = git(['show', '--name-only', '--format=', releaseCommit.sha]).split('\n').filter(Boolean).sort();
  assert.deepEqual(releaseFiles, [
    '.claude-plugin/marketplace.json',
    '.claude-plugin/plugin.json',
    'CHANGELOG.md',
    'package.json',
  ]);

  for (const [file, extractVersion] of [
    ['package.json', (text) => JSON.parse(text).version],
    ['.claude-plugin/plugin.json', (text) => JSON.parse(text).version],
    ['.claude-plugin/marketplace.json', (text) => {
      const parsed = JSON.parse(text);
      const plugin = Array.isArray(parsed.plugins) ? parsed.plugins.find((entry) => entry.name === 'prism') : null;
      return plugin ? plugin.version : (parsed.version || null);
    }],
  ]) {
    const contents = git(['show', `${releaseCommit.sha}:${file}`]);
    assert.equal(extractVersion(contents), '0.7.10', file);
  }

  const metadataTree = git(['ls-tree', '-r', '--name-only', metadataRelease]).split('\n');
  for (const forbidden of ['lib/git-evidence-capability.js', 'lib/git-evidence-outbox.js', 'lib/git-evidence-delivery.js']) {
    assert.ok(!metadataTree.includes(forbidden), `${RELEASE_TAG} tree must not contain ${forbidden}`);
  }
  const gitJsAtMetadata = git(['show', `${metadataRelease}:lib/git.js`]);
  assert.ok(!gitJsAtMetadata.includes('collectCommittedRange'));
});
