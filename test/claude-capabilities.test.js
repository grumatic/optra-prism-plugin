const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  CLAUDE_CODE_CAPABILITY_BOUNDARIES,
} = require('../lib/claude-capabilities');

const EXPECTED_BOUNDARIES = {
  stopResponse: '2.1.47',
  userConfig: '2.1.83',
  cwdChanged: '2.1.83',
  toolCorrelation: '2.1.119',
  numericAttributesFrom: '2.1.122',
  coreEvents: '2.1.161',
  nativeResponse: '2.1.193',
  promptCorrelation: '2.1.196',
};

function semverParts(version) {
  return version.split('.').map(Number);
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

test('declares the reviewed Claude Code capability boundaries', () => {
  assert.deepEqual(CLAUDE_CODE_CAPABILITY_BOUNDARIES, EXPECTED_BOUNDARIES);
});

test('declares valid and ordered semantic versions', () => {
  const versions = Object.values(CLAUDE_CODE_CAPABILITY_BOUNDARIES);

  for (const version of versions) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
  }
  assert.deepEqual(versions, [...versions].sort(compareSemver));
});

test('documents every capability boundary in the public README', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

  for (const version of Object.values(CLAUDE_CODE_CAPABILITY_BOUNDARIES)) {
    assert.ok(readme.includes(version), `README is missing Claude Code ${version}`);
  }
});
