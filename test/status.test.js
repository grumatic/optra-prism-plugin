const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { renderStatus } = require('../lib/status');
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
      } else {
        const file = path.join(root, child);
        snapshot.push(`file:${child}:${fs.statSync(file).mode & 0o777}:${fs.readFileSync(file).toString('base64')}`);
      }
    }
  }
  walk();
  return snapshot;
}

test('status is read-only and resolves effective settings user to project to local', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-status-readonly-'));
  const projectDir = path.join(home, 'project');
  const pluginData = path.join(home, 'plugin-data-must-not-be-created');
  const configuredHelper = path.join(home, 'configured-helper-must-not-run.js');
  const executionMarker = path.join(home, 'helper-was-executed');
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  fs.writeFileSync(
    configuredHelper,
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(executionMarker)}, 'executed');\n`,
    { mode: 0o700 },
  );
  writeJson(path.join(home, '.prism', 'config.json'), {
    apiKey: 'prism_status_readonly',
    ingest_url: 'http://127.0.0.1:1',
    dashboard_url: 'https://dashboard.example.test',
    show_realtime_summary: false,
  });
  writeJson(path.join(home, '.claude', 'settings.json'), {
    otelHeadersHelper: '/user/helper',
    env: {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://user.example/v1/logs',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://user.example/v1/metrics',
    },
  });
  writeJson(path.join(projectDir, '.claude', 'settings.json'), {
    otelHeadersHelper: '/project/helper',
    env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://project.example/v1/logs' },
  });
  writeJson(path.join(projectDir, '.claude', 'settings.local.json'), {
    otelHeadersHelper: configuredHelper,
    env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://local.example/v1/logs' },
  });
  const before = snapshotTree(home);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'status.js'),
      '--project-dir',
      projectDir,
      '--data-dir',
      pluginData,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PLUGIN_DATA: pluginData,
        PRISM_API_KEY: 'hostile-env-key',
        PRISM_INGEST_URL: 'https://hostile-ingest.invalid',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://hostile-process.example/v1/logs',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://hostile-process.example/v1/metrics',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Effective OTEL Logs:\*\* https:\/\/local\.example\/v1\/logs \(source: local/);
    assert.match(result.stdout, /Effective OTEL Metrics:\*\* https:\/\/user\.example\/v1\/metrics \(source: user/);
    assert.match(
      result.stdout,
      new RegExp(
        `Disk-effective OTEL Headers Helper:\\*\\* ${configuredHelper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ` +
        '\\(source: local ',
      ),
    );
    assert.match(
      result.stdout,
      new RegExp(
        `Expected Prism OTEL Headers Helper:\\*\\* ${path.join(pluginData, 'bin', 'prism-otel-headers-helper.js')
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
    );
    assert.match(
      result.stdout,
      /Prism-managed helper artifact:\*\* exists=no, regular file=unknown, not symlink=unknown, safe path=no/,
    );
    assert.match(
      result.stdout,
      /Prism-managed helper path chain:\*\* data dir: exists=no, directory=unknown, not symlink=unknown/,
    );
    assert.match(result.stdout, /Helper setting conflict:\*\* Prism preserved the effective OTEL headers helper from local/);
    assert.match(result.stdout, /`\/prism:setup` will not overwrite that setting/);
    assert.match(result.stdout, /reproject non-helper OTEL values; Prism will preserve the conflicting helper/);
    assert.match(result.stdout, /managed settings and CLI overrides are outside this reader/);
    assert.doesNotMatch(result.stdout, /hostile-(?:env|ingest|process)/);
    assert.equal(fs.existsSync(executionMarker), false);
    assert.deepEqual(snapshotTree(home), before);
    assert.equal(fs.existsSync(pluginData), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('status rejects unknown, duplicate, incomplete, and relative data-dir arguments', () => {
  const cases = [
    ['--unknown'],
    ['--project-dir'],
    ['--data-dir'],
    ['--data-dir', 'relative/plugin-data'],
    ['--data-dir', '/one', '--data-dir', '/two'],
  ];

  for (const args of cases) {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'lib', 'status.js'),
      ...args,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^\[prism:status\] /, args.join(' '));
    assert.doesNotMatch(result.stderr, /\n\s+at |Node\.js v/, args.join(' '));
  }
});

test('renders config authority and effective on-disk OTEL sources', () => {
  const output = renderStatus({
    config: {
      apiKey: 'opaque-config-key',
      ingest_url: 'https://ingest.example.test',
      dashboard_url: 'https://dashboard.example.test',
      show_realtime_summary: true,
    },
    rawConfig: {
      apiKey: 'opaque-config-key',
      ingest_url: 'https://ingest.example.test',
      dashboard_url: 'https://dashboard.example.test',
      show_realtime_summary: true,
    },
    installScope: 'project',
    effectiveSettings: {
      env: {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ingest.example.test/v1/logs',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://ingest.example.test/v1/metrics',
      },
      sources: {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'project',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'local',
      },
      files: {
        user: '/home/test/.claude/settings.json',
        project: '/workspace/project/.claude/settings.json',
        local: '/workspace/project/.claude/settings.local.json',
      },
    },
    expectedOtel: {
      otelEnv: {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ingest.example.test/v1/logs',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://ingest.example.test/v1/metrics',
      },
    },
    otelStatus: { ok: true, mismatches: [] },
    health: { ok: true, reachable: true, httpStatus: 200, error: null },
  });

  assert.equal(output, [
    '**Prism Status**',
    '',
    '**Prism API key:** present (source: ~/.prism/config.json)',
    '',
    '**Ingest URL:** https://ingest.example.test (source: ~/.prism/config.json)',
    '**Dashboard URL:** https://dashboard.example.test (source: ~/.prism/config.json)',
    '**Install scope:** project',
    '',
    '**Effective OTEL Logs:** https://ingest.example.test/v1/logs (source: project (/workspace/project/.claude/settings.json))',
    '**Expected OTEL Logs:** https://ingest.example.test/v1/logs',
    '**Effective OTEL Metrics:** https://ingest.example.test/v1/metrics (source: local (/workspace/project/.claude/settings.local.json))',
    '**Expected OTEL Metrics:** https://ingest.example.test/v1/metrics',
    '**OTEL settings:** configured on disk.',
    '**Restart:** Restart Claude Code if the API key or ingest_url changed since launch.',
    '',
    '**Ingest health endpoint:** reachable (HTTP 200)',
    '**Prompt capture:** prerequisites present; authentication and capture result not checked',
    '**Realtime summary setting:** On (source: ~/.prism/config.json)',
    '**Session:** Realtime session totals are stored in isolated, hashed runtime records.',
    '',
    'Run `/prism:help` for all commands.',
    '**Next:** open https://dashboard.example.test/ for realtime coaching, PRISM scores, and insights.',
  ].join('\n'));
  assert.doesNotMatch(output, /process env|source: env/i);
});

test('does not claim OTEL is configured when the managed helper is tampered', () => {
  const helperPath = '/home/test/plugin-data/bin/prism-otel-headers-helper.js';
  const output = renderStatus({
    config: {
      apiKey: 'opaque-config-key',
      ingest_url: 'https://ingest.example.test',
      show_realtime_summary: false,
    },
    rawConfig: {
      apiKey: 'opaque-config-key',
      ingest_url: 'https://ingest.example.test',
    },
    installScope: 'user',
    effectiveSettings: {
      env: {},
      sources: {},
      files: {
        user: '/home/test/.claude/settings.json',
        project: '/workspace/.claude/settings.json',
        local: '/workspace/.claude/settings.local.json',
      },
    },
    expectedOtel: null,
    otelStatus: { ok: true, mismatches: [] },
    helperDiagnostic: {
      expectedPath: helperPath,
      expectedPathError: null,
      effective: {
        value: helperPath,
        source: 'user',
        files: {
          user: '/home/test/.claude/settings.json',
        },
      },
      configuredPath: helperPath,
      exists: true,
      regularFile: true,
      notSymlink: true,
      safePath: true,
      ownedByCurrentUser: true,
      exactMode: true,
      executable: true,
      matchesBundledSource: false,
      dataDirExists: true,
      dataDirDirectory: true,
      dataDirNotSymlink: true,
      binDirExists: true,
      binDirDirectory: true,
      binDirNotSymlink: true,
      ok: false,
      reason: 'managed helper differs from bundled source',
    },
    health: { ok: true, reachable: true, httpStatus: 200, error: null },
  });

  assert.match(output, /bundled bytes=no/);
  assert.match(output, /OTEL settings:\*\* out of sync \(1 value\(s\)\)/);
  assert.match(output, /otelHeadersHelper \(effective source: user/);
  assert.doesNotMatch(output, /OTEL settings:\*\* configured on disk/);
});

test('renders missing config and disk projection drift without process-env claims', () => {
  const output = renderStatus({
    config: {
      apiKey: '',
      show_realtime_summary: false,
    },
    rawConfig: {},
    installScope: null,
    effectiveSettings: {
      env: {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://project-override.example/v1/logs',
      },
      sources: {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'project',
      },
      files: {
        project: '/workspace/project/.claude/settings.json',
      },
    },
    expectedOtel: null,
    otelStatus: {
      ok: false,
      mismatches: ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'],
    },
    health: { ok: false, reachable: false, httpStatus: null, error: 'connection refused' },
  });

  assert.match(output, /Prism API key:\*\* missing \(source: default\)/);
  assert.match(output, /Ingest URL:\*\* not configured \(source: not set\)/);
  assert.match(output, /Dashboard URL:\*\* not configured \(source: not set\)/);
  assert.match(output, /Effective OTEL Logs:\*\* https:\/\/project-override\.example\/v1\/logs \(source: project \(\/workspace\/project\/\.claude\/settings\.json\)\)/);
  assert.match(output, /Effective OTEL Metrics:\*\* not set \(source: not set\)/);
  assert.match(output, /Expected OTEL Logs:\*\* unavailable until Prism is configured/);
  assert.match(output, /OTEL settings:\*\* out of sync \(2 value\(s\)\)/);
  assert.match(output, /OTEL_EXPORTER_OTLP_LOGS_ENDPOINT \(effective source: project/);
  assert.match(output, /OTEL_EXPORTER_OTLP_METRICS_ENDPOINT \(effective source: not set\)/);
  assert.match(output, /Ingest health endpoint:\*\* unreachable \(connection refused\)/);
  assert.match(output, /Prompt capture:\*\* not configured/);
  assert.match(output, /Realtime summary setting:\*\* Off \(source: default\)/);
  assert.doesNotMatch(output, /process env|source: env|active features/i);
});

test('renders an unsupported stored ingest URL without claiming capture readiness', () => {
  const output = renderStatus({
    config: {
      apiKey: 'opaque-key',
      ingest_url: 'http://remote.example',
      show_realtime_summary: false,
    },
    rawConfig: {
      apiKey: 'opaque-key',
      ingest_url: 'http://remote.example',
    },
    installScope: 'user',
    effectiveSettings: {
      env: {},
      sources: {},
      files: {
        user: '/home/test/.claude/settings.json',
        project: '/workspace/.claude/settings.json',
        local: '/workspace/.claude/settings.local.json',
      },
    },
    expectedOtel: null,
    otelStatus: { ok: false, mismatches: ['no valid config'] },
    health: {
      ok: false,
      reachable: false,
      httpStatus: null,
      error: 'ingest URL is missing or unsupported',
    },
  });

  assert.match(output, /Ingest URL safety:\*\* unsupported/);
  assert.match(output, /Prompt capture:\*\* not configured/);
  assert.match(output, /Ingest health endpoint:\*\* unreachable \(ingest URL is missing or unsupported\)/);
});

test('malformed config is reported by status without a raw module-load stack', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-status-invalid-config-'));
  const configFile = path.join(home, '.prism', 'config.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '{ invalid json\n');

  try {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'lib', 'status.js')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\[prism:status\] Fatal: Unable to read Prism config/);
    assert.doesNotMatch(result.stderr, /\n\s+at |Node\.js v/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
