const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SUBMIT_HANDLER = path.join(ROOT, 'hooks', 'scripts', 'submit-handler.js');
const SENTINEL = 'prism_submit_handler_secret_sentinel';
const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readAllFiles(dir) {
  if (!fs.existsSync(dir)) return '';

  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const entryPath = path.join(dir, entry.name);
    return entry.isDirectory() ? readAllFiles(entryPath) : fs.readFileSync(entryPath, 'utf8');
  }).join('');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('/prism control prompts do not capture stdin or produce side effects', () => {
  const home = makeTempDir('prism-hook-home-');
  const dataDir = makeTempDir('prism-hook-data-');
  const env = { ...process.env };

  for (const key of [
    'PRISM_API_KEY',
    'PRISM_GCK_KEY',
    'CLAUDE_PLUGIN_OPTION_apiKey',
    'CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY',
    'CLAUDE_PLUGIN_OPTION_showRealtimeSummary',
    'PRISM_DEBUG',
  ]) {
    delete env[key];
  }
  const fetchMarker = path.join(home, 'fetch-called');
  const fetchBlocker = path.join(home, 'block-fetch.js');
  fs.writeFileSync(fetchBlocker, [
    "const fs = require('node:fs');",
    'global.fetch = async () => {',
    "  fs.writeFileSync(process.env.PRISM_FETCH_MARKER, 'called');",
    "  throw new Error('fetch blocked');",
    '};',
    '',
  ].join('\n'));

  const result = spawnSync(process.execPath, [SUBMIT_HANDLER], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: 'control-session',
      cwd: ROOT,
      prompt: `/prism:setup ${SENTINEL}`,
    }),
    env: {
      ...env,
      HOME: home,
      CLAUDE_PLUGIN_DATA: dataDir,
      PRISM_INGEST_URL: 'http://127.0.0.1:9',
      PRISM_API_KEY: 'prism_1234567890abcdef',
      PRISM_DEBUG: '1',
      PRISM_FETCH_MARKER: fetchMarker,
      NODE_OPTIONS: `--require=${fetchBlocker}`,
    },
    timeout: 1000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  assert.doesNotMatch(result.stdout, new RegExp(SENTINEL));
  assert.doesNotMatch(result.stderr, new RegExp(SENTINEL));
  assert.equal(readAllFiles(home).includes(SENTINEL), false);
  assert.equal(readAllFiles(dataDir).includes(SENTINEL), false);
  assert.equal(fs.existsSync(path.join(home, '.prism', 'advisor-context.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'session-state.json')), false);
  assert.equal(fs.existsSync(fetchMarker), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'debug.log')), false);
});
