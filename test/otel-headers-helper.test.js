const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const SOURCE = path.resolve(__dirname, '..', 'lib', 'otel-headers-helper.js');
const tempDirs = [];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-otel-helper-'));
  tempDirs.push(root);
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const helper = path.join(dataDir, 'bin', 'prism-otel-headers-helper.js');
  fs.mkdirSync(path.join(homeDir, '.prism'), { recursive: true });
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.copyFileSync(SOURCE, helper);
  return { dataDir, helper, homeDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('emits the opaque API key and active stable plugin version', () => {
  const { dataDir, helper, homeDir } = makeFixture();
  fs.writeFileSync(path.join(homeDir, '.prism', 'config.json'), JSON.stringify({
    apiKey: 'opaque key with punctuation !@#$%',
  }));
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '1.2.3\n');

  const result = spawnSync(process.execPath, [helper], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    'x-api-key': 'opaque key with punctuation !@#$%',
    'x-prism-plugin-version': '1.2.3',
  });
  assert.equal(result.stderr, '');
});

test('keeps API authentication when the active version marker is unavailable or invalid', () => {
  const { dataDir, helper, homeDir } = makeFixture();
  fs.writeFileSync(path.join(homeDir, '.prism', 'config.json'), JSON.stringify({
    apiKey: 'opaque-key',
  }));
  fs.writeFileSync(path.join(dataDir, 'last-version.txt'), '1.2.3-beta.1\n');

  const result = spawnSync(process.execPath, [helper], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { 'x-api-key': 'opaque-key' });
});

test('fails without leaking config content when the API key is unavailable', () => {
  const { helper, homeDir } = makeFixture();
  fs.writeFileSync(path.join(homeDir, '.prism', 'config.json'), JSON.stringify({
    ingest_url: 'https://secret.example',
  }));

  const result = spawnSync(process.execPath, [helper], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '[Prism] OTEL headers unavailable\n');
  assert.equal(result.stderr.includes('secret.example'), false);
});
