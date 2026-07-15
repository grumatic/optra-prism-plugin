const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  HEADER_NAME,
  addPluginVersionHeader,
  buildOtelHeaders,
  normalizePluginVersion,
  readPluginVersion,
} = require('../lib/plugin-version');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-version-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('normalizes the current plugin version', () => {
  assert.equal(normalizePluginVersion('0.4.9'), '0.4.9');
});

test('trims outer whitespace', () => {
  assert.equal(normalizePluginVersion('  0.4.9\n'), '0.4.9');
});

test('accepts safe non-semver and prerelease strings', () => {
  for (const value of ['v1.2.3', 'unknown', '1.2.3-beta.1+sha.abc']) {
    assert.equal(normalizePluginVersion(value), value);
  }
});

test('rejects non-string, empty, and whitespace-only values', () => {
  for (const value of [null, undefined, 409, {}, [], '', ' \n\t ']) {
    assert.equal(normalizePluginVersion(value), null);
  }
});

test('accepts 64 allowed characters and rejects 65', () => {
  assert.equal(normalizePluginVersion('a'.repeat(64)), 'a'.repeat(64));
  assert.equal(normalizePluginVersion('a'.repeat(65)), null);
});

test('rejects slash, internal whitespace, and non-ASCII characters', () => {
  for (const value of ['1.2/3', '1.2 3', 'version-한글']) {
    assert.equal(normalizePluginVersion(value), null);
  }
});

test('reads and normalizes a valid temporary manifest', (t) => {
  const manifestFile = path.join(temporaryDirectory(t), 'plugin.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ version: '  v1.2.3  ' }));

  assert.equal(readPluginVersion(manifestFile), 'v1.2.3');
});

test('returns null for unreadable or invalid manifests', (t) => {
  const directory = temporaryDirectory(t);
  const cases = [
    ['malformed.json', '{'],
    ['non-object.json', JSON.stringify('manifest')],
    ['missing-version.json', JSON.stringify({ name: 'prism' })],
    ['invalid-version.json', JSON.stringify({ version: '1.2/3' })],
  ];

  assert.equal(readPluginVersion(path.join(directory, 'missing.json')), null);
  for (const [name, contents] of cases) {
    const manifestFile = path.join(directory, name);
    fs.writeFileSync(manifestFile, contents);
    assert.equal(readPluginVersion(manifestFile), null, name);
  }
});

test('canonical read matches the normalized plugin manifest version', () => {
  const manifestFile = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  assert.equal(readPluginVersion(), normalizePluginVersion(manifest.version));
});

test('adds a valid plugin version to the same header object', () => {
  const headers = { 'x-api-key': 'prism_test' };
  const result = addPluginVersionHeader(headers, '  v1.2.3  ');

  assert.equal(result, headers);
  assert.deepEqual(headers, {
    'x-api-key': 'prism_test',
    [HEADER_NAME]: 'v1.2.3',
  });
});

test('explicit null and invalid plugin versions leave headers unchanged', () => {
  for (const value of [null, '1.2/3']) {
    const headers = { 'x-api-key': 'prism_test' };
    assert.equal(addPluginVersionHeader(headers, value), headers);
    assert.deepEqual(headers, { 'x-api-key': 'prism_test' });
  }
});

test('builds the exact OTLP header string with a valid plugin version', () => {
  assert.equal(
    buildOtelHeaders('prism_test', 'v1.2.3'),
    'x-api-key=prism_test,x-prism-plugin-version=v1.2.3',
  );
});

test('builds the API-key-only OTLP header for explicit missing or invalid versions', () => {
  for (const value of [null, '1.2/3']) {
    assert.equal(buildOtelHeaders('prism_test', value), 'x-api-key=prism_test');
  }
});

test('preserves a legacy API key in the OTLP header string', () => {
  assert.equal(
    buildOtelHeaders('gck_test', 'v1.2.3'),
    'x-api-key=gck_test,x-prism-plugin-version=v1.2.3',
  );
});
