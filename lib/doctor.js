#!/usr/bin/env node
/**
 * Prism Doctor — diagnostic checks for plugin configuration.
 *
 * Runs 4 checks and renders a human-readable report by default. Pass `--json`
 * to receive the machine-readable result instead.
 *   1. API Key        — ~/.prism/config.json has a non-empty key
 *   2. OTEL Settings  — effective on-disk settings match the projection
 *   3. Ingest Health  — HTTP probe against the configured ingest health endpoint
 *   4. OTEL Helper    — the on-disk helper setting and artifact are safe
 *
 * CLI: node lib/doctor.js [--json] [--project-dir PATH] [--data-dir PATH]
 * Exit: 0 = report generated, 2 = invalid input or API key, 1 = unexpected error
 */

const path = require('path');
const {
  OTEL_HEADERS_HELPER_KEY,
  buildExpectedOtelEnv,
  checkOtelSettings,
} = require('./settings');
const { getConfig } = require('./config');
const { healthCheck } = require('./ingest');
const {
  formatArtifact,
  formatHelperConflict,
  formatHelperPathChain,
  helperHasEffectiveConflict,
  inspectOtelHeadersHelper,
} = require('./status');
// ─── Check 1: API Key ───

function checkApiKey(config) {
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    return {
      id: 'api-key', name: 'API Key', status: 'fail',
      message: 'No API key present in ~/.prism/config.json',
      remediation: 'Run /prism:setup KEY',
    };
  }
  return {
    id: 'api-key', name: 'API Key', status: 'pass',
    message: 'Prism API key present in ~/.prism/config.json',
    remediation: null,
  };
}

// ─── Check 2: OTEL Settings ───

function checkOtelProjection(projectDir, dataDir) {
  const result = checkOtelSettings({ projectDir, dataDir });
  const envMismatches = result.mismatches.filter((key) => key !== OTEL_HEADERS_HELPER_KEY);
  if (envMismatches.length > 0) {
    return {
      id: 'otel-settings', name: 'OTEL Settings', status: 'fail',
      message: `Out of sync: ${envMismatches.join(', ')}`,
      remediation: 'Run /prism:setup KEY (or reapply ingest_url with /prism:config), then restart Claude Code',
    };
  }

  const expected = buildExpectedOtelEnv();
  return {
    id: 'otel-settings', name: 'OTEL Settings', status: 'pass',
    message: `All ${Object.keys(expected.otelEnv).length} expected values match effective Claude settings on disk`,
    remediation: null,
  };
}

// ─── Check 3: Ingest Health Endpoint ───

async function checkIngestConnectivity(config) {
  const ingestUrl = config.ingest_url;
  if (typeof ingestUrl !== 'string' || ingestUrl.length === 0) {
    return {
      id: 'ingest-connectivity', name: 'Ingest Health Endpoint', status: 'fail',
      message: 'No ingest URL configured in ~/.prism/config.json',
      remediation: 'Run /prism:setup KEY or configure ingest_url with /prism:config',
    };
  }

  const healthUrl = `${ingestUrl.replace(/\/+$/, '')}/health`;
  const health = await healthCheck(ingestUrl);
  const detail = health.reachable
    ? `reachable (HTTP ${health.httpStatus || 'unknown'})`
    : `unreachable${health.error ? ` (${health.error})` : ''}`;

  return {
    id: 'ingest-connectivity', name: 'Ingest Health Endpoint', status: health.ok ? 'pass' : 'fail',
    message: `${healthUrl}: ${detail}`,
    remediation: health.ok ? null : 'Check the HTTP status, network connectivity, and ~/.prism/config.json ingest_url',
  };
}

// ─── Check 4: OTEL Headers Helper ───

function formatHelperSource(diagnostic) {
  const { effective } = diagnostic;
  if (!effective.source) return 'not set';
  return `${effective.source} (${effective.files[effective.source]})`;
}

function formatHelperValue(value) {
  if (value === undefined) return 'not set';
  if (typeof value === 'string') return value.length > 0 ? value : 'invalid empty string';
  if (value === null) return 'invalid null';
  return `invalid ${Array.isArray(value) ? 'array' : typeof value}`;
}

function checkOtelHeadersHelper(projectDir, dataDir) {
  const diagnostic = inspectOtelHeadersHelper({ projectDir, dataDir });
  const coverage = 'managed settings and CLI overrides are outside this reader';
  if (!diagnostic.expectedPath) {
    return {
      id: 'otel-headers-helper',
      name: 'OTEL Headers Helper',
      status: 'warn',
      message: `Expected path unavailable (${diagnostic.expectedPathError}); ${coverage}`,
      remediation: 'Invoke Prism Doctor with --data-dir set to the absolute CLAUDE_PLUGIN_DATA path',
    };
  }

  const configured = formatHelperValue(diagnostic.effective.value);
  const source = formatHelperSource(diagnostic);
  const samePath = diagnostic.configuredPath === diagnostic.expectedPath;
  const message = `Disk-effective: ${configured} (source: ${source}); ` +
    `expected: ${diagnostic.expectedPath}; managed artifact: ${formatArtifact(diagnostic)}; ` +
    `path chain: ${formatHelperPathChain(diagnostic)}; ${coverage}`;
  const ok = samePath && diagnostic.ok === true;

  let remediation = null;
  if (!ok && helperHasEffectiveConflict(diagnostic)) {
    remediation = formatHelperConflict(diagnostic);
  } else if (!ok && diagnostic.safePath === false && diagnostic.exists === true) {
    remediation = `Review ownership and symlinks under ${diagnostic.expectedPath}, ` +
      'then run /prism:setup KEY and restart Claude Code';
  } else if (!ok) {
    remediation = 'Run /prism:setup KEY to restore the Prism-managed helper, then restart Claude Code';
  }

  return {
    id: 'otel-headers-helper',
    name: 'OTEL Headers Helper',
    status: ok ? 'pass' : 'fail',
    message,
    remediation,
  };
}

// ─── Runner ───

async function runChecks({ projectDir, dataDir } = {}) {
  const config = getConfig();
  const checks = [
    checkApiKey(config),
    checkOtelProjection(projectDir, dataDir),
    await checkIngestConnectivity(config),
    checkOtelHeadersHelper(projectDir, dataDir),
  ];
  const summary = {
    passed: checks.filter(c => c.status === 'pass').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    failed: checks.filter(c => c.status === 'fail').length,
  };

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    checks,
    summary,
  };
}

// ─── Rendering ───

function renderReport(results) {
  const { checks = [], summary = {} } = results || {};
  const passed = summary.passed || 0;
  const warnings = summary.warnings || 0;
  const failed = summary.failed || 0;
  const lines = [
    `**Prism Doctor** — ${passed} passed, ${warnings} warnings, ${failed} failed`,
    '',
    '| # | Check | Status | Details |',
    '|---|-------|--------|---------|',
  ];

  for (const [index, check] of checks.entries()) {
    lines.push(`| ${index + 1} | ${check.name} | ${(check.status || 'fail').toUpperCase()} | ${check.message} |`);
  }

  const issues = checks.filter((check) => check.status === 'warn' || check.status === 'fail');
  if (issues.length > 0) {
    lines.push('', '**Issues:**');
    for (const [index, check] of issues.entries()) {
      lines.push(`${index + 1}. **${check.name}:** ${check.message}`);
      if (check.remediation) lines.push(`   **Fix:** ${check.remediation}`);
    }
  }

  if (failed === 0 && warnings === 0) {
    lines.push(
      '',
      'All local configuration and health endpoint checks passed.',
      'Authentication and capture result are not checked.',
    );
  }

  lines.push('', 'Run `/prism:help` for all commands.');
  return lines.join('\n');
}

// ─── CLI ───

function parseArgs(argv) {
  const args = {
    projectDir: process.env.CLAUDE_PROJECT_DIR || null,
    dataDir: null,
    json: false,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option !== '--json' && option !== '--project-dir' && option !== '--data-dir') {
      throw new TypeError(`Unknown or incomplete argument: ${option}`);
    }
    if (seen.has(option)) {
      throw new TypeError(`Duplicate argument: ${option}`);
    }
    seen.add(option);
    if (option === '--json') {
      args.json = true;
      continue;
    }

    const value = argv[i + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new TypeError(`Unknown or incomplete argument: ${option}`);
    }
    i += 1;
    if (option === '--project-dir') {
      args.projectDir = value;
    } else if (!path.isAbsolute(value)) {
      throw new TypeError('--data-dir must be an absolute path');
    } else {
      args.dataDir = value;
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[prism:doctor] ${err.message}\n`);
    return 2;
  }

  try {
    const result = await runChecks({
      projectDir: args.projectDir,
      dataDir: args.dataDir,
    });
    const output = args.json ? JSON.stringify(result, null, 2) : renderReport(result);
    process.stdout.write(output + '\n');
    return result.checks.some((check) =>
      check.id === 'api-key' && check.status === 'fail') ? 2 : 0;
  } catch (err) {
    process.stderr.write(`[prism:doctor] Fatal: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  checkOtelHeadersHelper,
  main,
  renderReport,
  runChecks,
};
