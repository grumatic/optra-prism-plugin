const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { renderReport } = require('../lib/doctor');
const { buildBinding } = require('../lib/binding');
const ROOT = path.resolve(__dirname, '..');

function snapshotTree(root) {
  const snapshot = [];
  function walk(relative = '') {
    const dir = path.join(root, relative);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`dir:${child}`);
        walk(child);
      } else if (entry.isSymbolicLink()) {
        snapshot.push(`symlink:${child}:${fs.readlinkSync(path.join(root, child))}`);
      } else {
        const file = path.join(root, child);
        snapshot.push(`file:${child}:${fs.statSync(file).mode & 0o777}:${fs.readFileSync(file).toString('base64')}`);
      }
    }
  }
  walk();
  return snapshot;
}

test('doctor rejects an arbitrary executable at the expected helper path without executing it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-key-'));
  const projectDir = path.join(home, 'project');
  const dataDir = path.join(home, 'plugin-data');
  const helper = path.join(dataDir, 'bin', 'prism-otel-headers-helper.js');
  const executionMarker = path.join(home, 'helper-was-executed');
  const configFile = path.join(home, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify({
    apiKey: 'opaque-key-without-a-known-prefix',
    ingest_url: 'http://127.0.0.1:1',
  }, null, 2)}\n`);
  fs.writeFileSync(
    helper,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed');\n`,
    { mode: 0o700 },
  );
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'settings.local.json'),
    `${JSON.stringify({ otelHeadersHelper: helper }, null, 2)}\n`,
  );
  const before = snapshotTree(home);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'),
      '--json',
      '--project-dir',
      projectDir,
      '--data-dir',
      dataDir,
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
    assert.equal(report.checks.length, 4);
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
    const helperCheck = report.checks.find((check) => check.id === 'otel-headers-helper');
    assert.equal(helperCheck.status, 'fail');
    assert.match(
      helperCheck.message,
      /managed artifact: exists=yes, regular file=yes, not symlink=yes, safe path=yes, current UID \(where supported\)=yes, exact mode 0700=yes, executable=yes, bundled bytes=no/,
    );
    assert.match(helperCheck.message, /managed settings and CLI overrides are outside this reader/);
    assert.match(helperCheck.remediation, /Run \/prism:setup KEY to restore the Prism-managed helper/);
    assert.equal(Object.hasOwn(report, 'autoFixed'), false);
    assert.equal(fs.existsSync(executionMarker), false);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor passes the exact bundled managed helper without executing it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-helper-bundled-'));
  const projectDir = path.join(home, 'project');
  const dataDir = path.join(home, 'plugin-data');
  const helper = path.join(dataDir, 'bin', 'prism-otel-headers-helper.js');
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.prism', 'config.json'),
    `${JSON.stringify({
      apiKey: 'opaque-key',
      ingest_url: 'http://127.0.0.1:1',
    })}\n`,
  );
  fs.copyFileSync(path.join(ROOT, 'lib', 'otel-headers-helper.js'), helper);
  fs.chmodSync(helper, 0o700);
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'settings.local.json'),
    `${JSON.stringify({ otelHeadersHelper: helper })}\n`,
  );
  const before = snapshotTree(home);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'),
      '--json',
      '--project-dir',
      projectDir,
      '--data-dir',
      dataDir,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

    assert.equal(result.status, 0, result.stderr);
    const helperCheck = JSON.parse(result.stdout).checks
      .find((check) => check.id === 'otel-headers-helper');
    assert.equal(helperCheck.status, 'pass');
    assert.match(
      helperCheck.message,
      /managed artifact: exists=yes, regular file=yes, not symlink=yes, safe path=yes, current UID \(where supported\)=yes, exact mode 0700=yes, executable=yes, bundled bytes=yes/,
    );
    assert.equal(helperCheck.remediation, null);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor rejects a symlinked helper without executing its target', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-helper-symlink-'));
  const projectDir = path.join(home, 'project');
  const dataDir = path.join(home, 'plugin-data');
  const helper = path.join(dataDir, 'bin', 'prism-otel-headers-helper.js');
  const target = path.join(home, 'target-helper.js');
  const executionMarker = path.join(home, 'helper-was-executed');
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.prism', 'config.json'),
    `${JSON.stringify({
      apiKey: 'opaque-key',
      ingest_url: 'http://127.0.0.1:1',
    })}\n`,
  );
  fs.writeFileSync(
    target,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed');\n`,
    { mode: 0o700 },
  );
  fs.symlinkSync(target, helper);
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'settings.local.json'),
    `${JSON.stringify({ otelHeadersHelper: helper })}\n`,
  );
  const before = snapshotTree(home);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'),
      '--json',
      '--project-dir',
      projectDir,
      '--data-dir',
      dataDir,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

    assert.equal(result.status, 0, result.stderr);
    const helperCheck = JSON.parse(result.stdout).checks
      .find((check) => check.id === 'otel-headers-helper');
    assert.equal(helperCheck.status, 'fail');
    assert.match(
      helperCheck.message,
      /managed artifact: exists=yes, regular file=no, not symlink=no, safe path=no/,
    );
    assert.equal(fs.existsSync(executionMarker), false);
    assert.deepEqual(snapshotTree(home), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor reports that an effective unrelated helper was preserved at its source setting', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-helper-conflict-'));
  const projectDir = path.join(home, 'project');
  const dataDir = path.join(home, 'plugin-data');
  const unrelatedHelper = path.join(home, 'custom-otel-helper');
  const sourceSettings = path.join(projectDir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.mkdirSync(path.dirname(sourceSettings), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.prism', 'config.json'),
    `${JSON.stringify({
      apiKey: 'opaque-key',
      ingest_url: 'http://127.0.0.1:1',
    })}\n`,
  );
  fs.writeFileSync(unrelatedHelper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(
    sourceSettings,
    `${JSON.stringify({ otelHeadersHelper: unrelatedHelper })}\n`,
  );

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'),
      '--json',
      '--project-dir',
      projectDir,
      '--data-dir',
      dataDir,
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

    assert.equal(result.status, 0, result.stderr);
    const helperCheck = JSON.parse(result.stdout).checks
      .find((check) => check.id === 'otel-headers-helper');
    assert.equal(helperCheck.status, 'fail');
    assert.match(helperCheck.message, new RegExp(
      `Disk-effective: ${unrelatedHelper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ` +
      `\\(source: local \\(${sourceSettings.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\)`,
    ));
    assert.match(helperCheck.remediation, /Prism preserved the effective OTEL headers helper from local/);
    assert.match(helperCheck.remediation, new RegExp(
      sourceSettings.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
    assert.match(helperCheck.remediation, /`\/prism:setup` will not overwrite that setting/);
    assert.doesNotMatch(helperCheck.remediation, /restore the Prism-managed helper/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function runDoctorJson(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-binding-'));
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config.json'), `${JSON.stringify(config)}\n`);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'), '--json', '--project-dir', projectDir,
    ], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    return {
      status: result.status,
      stderr: result.stderr,
      apiKey: JSON.parse(result.stdout).checks.find((check) => check.id === 'api-key'),
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('doctor fails the API key check when the key is not bound to the configured ingest_url', () => {
  const result = runDoctorJson({
    apiKey: 'opaque-key',
    ingest_url: 'http://127.0.0.1:1',
    binding: buildBinding({ apiKey: 'opaque-key', ingestUrl: 'https://ingest.dev.example' }),
  });

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.apiKey.status, 'fail');
  assert.match(result.apiKey.message, /not bound to the configured ingest_url/);
  assert.match(result.apiKey.message, /verified for ingest\.dev\.example/);
  assert.match(result.apiKey.message, /ingest_url points to 127\.0\.0\.1:1/);
  assert.match(result.apiKey.remediation, /Run \/prism:setup KEY/);
});

test('doctor reports the bound destination and stays silent about unsealed pairs', () => {
  const bound = runDoctorJson({
    apiKey: 'opaque-key',
    ingest_url: 'http://127.0.0.1:1',
    binding: buildBinding({ apiKey: 'opaque-key', ingestUrl: 'http://127.0.0.1:1/' }),
  });

  assert.equal(bound.apiKey.status, 'pass');
  assert.match(bound.apiKey.message, /bound to 127\.0\.0\.1:1/);
  assert.equal(bound.apiKey.remediation, null);

  const unsealed = runDoctorJson({ apiKey: 'opaque-key', ingest_url: 'http://127.0.0.1:1' });

  assert.equal(unsealed.apiKey.status, 'pass');
  assert.equal(unsealed.apiKey.message, 'Prism API key present in ~/.prism/config.json');
  assert.doesNotMatch(unsealed.apiKey.message, /bound/);
});

function runDoctorReport(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-notice-'));
  const projectDir = path.join(home, 'project');
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config.json'), `${JSON.stringify(config)}\n`);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'), '--project-dir', projectDir,
    ], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('doctor reports enabled debug logging and stays silent when it is off', () => {
  const withDebug = runDoctorReport({
    apiKey: 'opaque-key',
    ingest_url: 'http://127.0.0.1:1',
    debug: true,
  });

  assert.match(withDebug, /\*\*Notices:\*\*/);
  assert.match(withDebug, /Debug logging is enabled in ~\/\.prism\/config\.json/);

  const withoutDebug = runDoctorReport({
    apiKey: 'opaque-key',
    ingest_url: 'http://127.0.0.1:1',
  });

  assert.doesNotMatch(withoutDebug, /Notices/);
  assert.doesNotMatch(withoutDebug, /Debug logging/);
});

test('doctor reports a malformed config without a raw module-load stack', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-malformed-'));
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.writeFileSync(path.join(home, '.prism', 'config.json'), '{ not json\n');

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'), '--project-dir', home,
    ], { encoding: 'utf8', env: { ...process.env, HOME: home } });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\[prism:doctor\] Fatal: Unable to read Prism config/m);
    assert.equal(result.stdout, '');
    // A module-scope require of the config snapshot would surface as a loader
    // stack before the entrypoint could report anything.
    assert.doesNotMatch(result.stderr, /Module\._compile|internal\/modules/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor reports the debug log under the data directory it was given', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-doctor-debug-path-'));
  const dataDir = path.join(home, 'plugin-data');
  fs.mkdirSync(path.join(home, '.prism'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.prism', 'config.json'),
    `${JSON.stringify({ apiKey: 'opaque-key', ingest_url: 'http://127.0.0.1:1', debug: true })}\n`,
  );

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'),
      '--project-dir', home,
      '--data-dir', dataDir,
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: '/nonexistent-ambient' } });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(path.join(dataDir, 'debug.log')), result.stdout);
    assert.doesNotMatch(result.stdout, /nonexistent-ambient/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor rejects unknown, duplicate, incomplete, and relative data-dir arguments', () => {
  const cases = [
    ['--unknown'],
    ['--json', '--json'],
    ['--project-dir'],
    ['--data-dir'],
    ['--data-dir', 'relative/plugin-data'],
    ['--data-dir', '/one', '--data-dir', '/two'],
  ];

  for (const args of cases) {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'doctor.js'),
      ...args,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^\[prism:doctor\] /, args.join(' '));
    assert.doesNotMatch(result.stderr, /\n\s+at |Node\.js v/, args.join(' '));
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

test('renders the four-check all-healthy doctor report', () => {
  const output = renderReport({
    checks: [
      { name: 'API Key', status: 'pass', message: 'Prism API key present in ~/.prism/config.json', remediation: null },
      { name: 'OTEL Settings', status: 'pass', message: 'All 10 expected values match effective Claude settings on disk', remediation: null },
      { name: 'Ingest Health Endpoint', status: 'pass', message: 'https://ingest.example.test/health: connected', remediation: null },
      { name: 'OTEL Headers Helper', status: 'pass', message: 'Managed helper is safe on disk', remediation: null },
    ],
    summary: { passed: 4, warnings: 0, failed: 0 },
  });

  assert.equal(output, [
    '**Prism Doctor** — 4 passed, 0 warnings, 0 failed',
    '',
    '| # | Check | Status | Details |',
    '|---|-------|--------|---------|',
    '| 1 | API Key | PASS | Prism API key present in ~/.prism/config.json |',
    '| 2 | OTEL Settings | PASS | All 10 expected values match effective Claude settings on disk |',
    '| 3 | Ingest Health Endpoint | PASS | https://ingest.example.test/health: connected |',
    '| 4 | OTEL Headers Helper | PASS | Managed helper is safe on disk |',
    '',
    'All local configuration and health endpoint checks passed.',
    'Authentication and capture result are not checked.',
    '',
    'Run `/prism:help` for all commands.',
  ].join('\n'));
});
