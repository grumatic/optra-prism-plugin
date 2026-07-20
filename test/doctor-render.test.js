const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { renderReport } = require('../lib/doctor');
const ROOT = path.resolve(__dirname, '..');

test('doctor treats any non-empty config key as present without prefix validation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-key-'));
  const projectDir = path.join(home, 'project');
  const configFile = path.join(home, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify({
    apiKey: 'opaque-key-without-a-known-prefix',
    ingest_url: 'http://127.0.0.1:1',
  }, null, 2)}\n`);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'),
      '--json',
      '--project-dir',
      projectDir,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PRISM_API_KEY: 'hostile-env-key',
        CLAUDE_PLUGIN_OPTION_APIKEY: 'hostile-option-key',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.length, 3);
    assert.deepEqual(
      report.checks.find((check) => check.id === 'api-key'),
      {
        id: 'api-key',
        name: 'API Key',
        status: 'pass',
        message: 'Prism API key present in ~/.prism/config.json',
        remediation: null,
      },
    );
    assert.equal(Object.hasOwn(report, 'autoFixed'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('renders config, effective OTEL projection, and connectivity failures', () => {
  const output = renderReport({
    checks: [
      { name: 'API Key', status: 'pass', message: 'Prism API key present in ~/.prism/config.json', remediation: null },
      { name: 'OTEL Settings', status: 'fail', message: 'Out of sync: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', remediation: 'Run /prism:setup KEY, then restart Claude Code' },
      { name: 'Ingest Health Endpoint', status: 'fail', message: 'https://ingest.example.test/health: unreachable', remediation: 'Check network connectivity and ~/.prism/config.json ingest_url' },
    ],
    summary: { passed: 1, warnings: 0, failed: 2 },
  });

  assert.equal(output, [
    '**Prism Doctor** — 1 passed, 0 warnings, 2 failed',
    '',
    '| # | Check | Status | Details |',
    '|---|-------|--------|---------|',
    '| 1 | API Key | PASS | Prism API key present in ~/.prism/config.json |',
    '| 2 | OTEL Settings | FAIL | Out of sync: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT |',
    '| 3 | Ingest Health Endpoint | FAIL | https://ingest.example.test/health: unreachable |',
    '',
    '**Issues:**',
    '1. **OTEL Settings:** Out of sync: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    '   **Fix:** Run /prism:setup KEY, then restart Claude Code',
    '2. **Ingest Health Endpoint:** https://ingest.example.test/health: unreachable',
    '   **Fix:** Check network connectivity and ~/.prism/config.json ingest_url',
    '',
    'Run `/prism:help` for all commands.',
  ].join('\n'));
  assert.doesNotMatch(output, /cache|auto-fixed|process env|key format/i);
});

test('renders the three-check all-healthy doctor report', () => {
  const output = renderReport({
    checks: [
      { name: 'API Key', status: 'pass', message: 'Prism API key present in ~/.prism/config.json', remediation: null },
      { name: 'OTEL Settings', status: 'pass', message: 'All 10 expected values match effective Claude settings on disk', remediation: null },
      { name: 'Ingest Health Endpoint', status: 'pass', message: 'https://ingest.example.test/health: connected', remediation: null },
    ],
    summary: { passed: 3, warnings: 0, failed: 0 },
  });

  assert.equal(output, [
    '**Prism Doctor** — 3 passed, 0 warnings, 0 failed',
    '',
    '| # | Check | Status | Details |',
    '|---|-------|--------|---------|',
    '| 1 | API Key | PASS | Prism API key present in ~/.prism/config.json |',
    '| 2 | OTEL Settings | PASS | All 10 expected values match effective Claude settings on disk |',
    '| 3 | Ingest Health Endpoint | PASS | https://ingest.example.test/health: connected |',
    '',
    'All local configuration and health endpoint checks passed.',
    'Authentication and capture result are not checked.',
    '',
    'Run `/prism:help` for all commands.',
  ].join('\n'));
});
