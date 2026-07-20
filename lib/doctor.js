#!/usr/bin/env node
/**
 * Prism Doctor — diagnostic checks for plugin configuration.
 *
 * Runs 3 checks and renders a human-readable report by default. Pass `--json`
 * to receive the machine-readable result instead.
 *   1. API Key        — ~/.prism/config.json has a non-empty key
 *   2. OTEL Settings  — effective on-disk settings match the projection
 *   3. Ingest Health  — HTTP probe against the configured ingest health endpoint
 *
 * CLI: node lib/doctor.js [--json] [--project-dir PATH]
 * Exit: 0 = report generated, 2 = invalid input or API key, 1 = unexpected error
 */

const {
  buildExpectedOtelEnv,
  checkOtelSettings,
} = require('./settings');
const { getConfig } = require('./config');
const { healthCheck } = require('./ingest');
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

function checkOtelProjection(projectDir) {
  const result = checkOtelSettings({ projectDir });
  if (!result.ok) {
    return {
      id: 'otel-settings', name: 'OTEL Settings', status: 'fail',
      message: `Out of sync: ${result.mismatches.join(', ')}`,
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

// ─── Runner ───

async function runChecks({ projectDir } = {}) {
  const config = getConfig();
  const checks = [
    checkApiKey(config),
    checkOtelProjection(projectDir),
    await checkIngestConnectivity(config),
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
  const args = { projectDir: process.env.CLAUDE_PROJECT_DIR || null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') {
      args.json = true;
    } else if (argv[i] === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[++i];
    } else {
      throw new TypeError(`Unknown or incomplete argument: ${argv[i]}`);
    }
  }
  return args;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[prism:doctor] ${err.message}\n`);
    process.exit(2);
  }

  runChecks({ projectDir: args.projectDir }).then(result => {
    const output = args.json ? JSON.stringify(result, null, 2) : renderReport(result);
    process.stdout.write(output + '\n');
    process.exit(result.checks.some((check) => check.id === 'api-key' && check.status === 'fail') ? 2 : 0);
  }).catch(err => {
    process.stderr.write(`[prism:doctor] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { runChecks, renderReport };
