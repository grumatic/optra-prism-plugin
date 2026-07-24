'use strict';

// Distribution boundary guard: every static require() reachable from the
// packaged runtime (lib/, hooks/scripts/) must resolve inside the paths that
// are promoted to main by the release projection (AGENTS.md "Release
// Projection"). Development-only paths (test/, .github/, docs/, AGENTS.md,
// CLAUDE.md) are excluded from main, so a runtime require() into them would
// crash a marketplace install even though develop-branch tests stay green.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_DIRS = ['lib', path.join('hooks', 'scripts')];
const DISTRIBUTION_PREFIXES = [
  'lib' + path.sep,
  'hooks' + path.sep,
  'commands' + path.sep,
  'agents' + path.sep,
  '.claude-plugin' + path.sep,
];
const DISTRIBUTION_FILES = new Set([
  'package.json',
  'install.sh',
  'CHANGELOG.md',
  'README.md',
]);

function runtimeSources() {
  const out = [];
  for (const dir of RUNTIME_DIRS) {
    const abs = path.join(ROOT, dir);
    for (const entry of fs.readdirSync(abs)) {
      if (entry.endsWith('.js')) out.push(path.join(abs, entry));
    }
  }
  return out;
}

function staticRequires(file) {
  const source = fs.readFileSync(file, 'utf8');
  const requires = [];
  const pattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) requires.push(match[2]);
  return requires;
}

test('packaged runtime requires resolve only inside distribution paths', () => {
  const violations = [];
  for (const file of runtimeSources()) {
    for (const spec of staticRequires(file)) {
      if (!spec.startsWith('.')) continue; // node builtin or dependency
      const resolved = require.resolve(path.resolve(path.dirname(file), spec));
      const relative = path.relative(ROOT, resolved);
      const isDistributionDir = DISTRIBUTION_PREFIXES.some((prefix) => relative.startsWith(prefix));
      const isDistributionFile = DISTRIBUTION_FILES.has(relative);
      if (!isDistributionDir && !isDistributionFile) {
        violations.push(`${path.relative(ROOT, file)} -> ${spec} (${relative})`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('no packaged runtime file references development-only paths', () => {
  const offenders = [];
  for (const file of runtimeSources()) {
    const source = fs.readFileSync(file, 'utf8');
    if (/(?:^|['"/])(?:test|fixtures)\//.test(source) || /\.\.\/(?:\.\.\/)?(?:test|fixtures)\//.test(source)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('commands and their dedicated agents are included by the package projection', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.ok(pkg.files.includes('lib/'));
  assert.ok(pkg.files.includes('commands/'));
  assert.ok(pkg.files.includes('agents/'));
  assert.equal(fs.existsSync(path.join(ROOT, 'lib', 'config-command.js')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'lib', 'uninstall.js')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'commands', 'config.md')), true);
  for (const agent of ['prism-config', 'prism-output', 'prism-setup', 'prism-uninstall']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'agents', `${agent}.md`)), true, agent);
  }
});
