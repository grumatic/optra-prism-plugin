#!/usr/bin/env node
/**
 * Prism Doctor — diagnostic checks for plugin configuration.
 *
 * Runs 5 checks and renders a human-readable report by default. Pass `--json`
 * to receive the machine-readable result instead.
 *   1. API Key        — ~/.prism/config.json has a key, still bound to ingest_url
 *   2. OTEL Settings  — host-effective settings match the projection and the
 *                       session applied the telemetry switch
 *   3. Ingest Health  — HTTP probe against the configured ingest health endpoint
 *   4. OTEL Helper    — the on-disk helper setting and artifact are safe
 *   5. Install Context — the plugin root and data dir match the Claude config root
 *
 * CLI: node lib/doctor.js [--json] [--project-dir PATH] [--data-dir PATH]
 * Exit: 0 = report generated, 2 = invalid input or API key, 1 = unexpected error
 */

const os = require('os');
const path = require('path');
const {
  OTEL_HEADERS_HELPER_KEY,
  buildExpectedOtelEnv,
  checkOtelSettings,
  resolveTelemetryScope,
} = require('./settings');
const {
  readSessionTelemetry,
  withheldTelemetryRemediation,
  withheldTelemetrySummary,
} = require('./host-telemetry');
const {
  CONFIG_DIR_ENV,
  PLUGIN_CACHE_DIR_ENV,
  describePluginContext,
  inspectClaudeContext,
} = require('./claude-paths');
const { getConfig } = require('./config');
const { verifyBinding } = require('./binding');
const { healthCheck } = require('./ingest');
const { verifyOtherRoots } = require('./install-inventory');
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

  const binding = verifyBinding(config);
  if (binding.status === 'mismatch') {
    return {
      id: 'api-key', name: 'API Key', status: 'fail',
      message: 'Key is not bound to the configured ingest_url: verified for '
        + `${binding.boundHost || 'another host'}, ingest_url points to `
        + `${binding.currentHost || 'an unreadable host'}`,
      remediation: 'Run /prism:setup KEY to verify the key against the current ingest_url',
    };
  }
  return {
    id: 'api-key', name: 'API Key', status: 'pass',
    message: binding.status === 'ok'
      ? 'Prism API key present in ~/.prism/config.json and bound to '
        + `${binding.boundHost || binding.currentHost}`
      : 'Prism API key present in ~/.prism/config.json',
    remediation: null,
  };
}

// ─── Check 2: OTEL Settings ───

function checkWithheldTelemetry(result, sessionTelemetry) {
  const scope = { scope: result.installScope, hostVersion: result.hostVersion };
  if (sessionTelemetry && sessionTelemetry.enabled) {
    return {
      id: 'otel-settings', name: 'OTEL Settings', status: 'warn',
      message: 'Telemetry is on in this session from settings outside the '
        + `${result.installScope} install scope; Prism does not manage its destination. `
        + withheldTelemetrySummary(scope),
      remediation: withheldTelemetryRemediation(scope),
    };
  }
  return {
    id: 'otel-settings', name: 'OTEL Settings', status: 'fail',
    message: withheldTelemetrySummary(scope),
    remediation: withheldTelemetryRemediation(scope),
  };
}

function checkOtelProjection(projectDir, dataDir, { hostVersion, sessionTelemetry, pluginRoot } = {}) {
  const result = checkOtelSettings({ projectDir, dataDir, pluginRoot, hostVersion });
  if (result.telemetryWithheld) return checkWithheldTelemetry(result, sessionTelemetry);
  const envMismatches = result.mismatches.filter((key) => key !== OTEL_HEADERS_HELPER_KEY);
  if (envMismatches.length > 0) {
    return {
      id: 'otel-settings', name: 'OTEL Settings', status: 'fail',
      message: `Out of sync: ${envMismatches.join(', ')}`,
      remediation: 'Run /prism:setup KEY (or reapply ingest_url with /prism:config), then restart Claude Code',
    };
  }

  if (result.assistantResponseConflict) {
    const { key, source, installScope } = result.assistantResponseConflict;
    return {
      id: 'otel-settings', name: 'OTEL Settings', status: 'warn',
      message: `${key} is "0" from the ${source} settings layer, which takes precedence over the `
        + `${installScope} scope Prism manages here`,
      remediation: `Prism cannot fix this by writing to the ${installScope} scope; review or remove `
        + `${key} in the ${source} settings file directly, then restart Claude Code`,
    };
  }

  const expected = buildExpectedOtelEnv();
  const matched = `All ${Object.keys(expected.otelEnv).length} expected values match effective Claude settings on disk`;
  if (sessionTelemetry && !sessionTelemetry.observable) {
    return {
      id: 'otel-settings', name: 'OTEL Settings', status: 'warn',
      message: `${matched}; the session telemetry switch is not observable outside Claude Code`,
      remediation: 'Run /prism:doctor inside a Claude Code session to confirm telemetry is on',
    };
  }
  if (sessionTelemetry && !sessionTelemetry.enabled) {
    return {
      id: 'otel-settings', name: 'OTEL Settings', status: 'warn',
      message: `${matched}, but telemetry is off in this session`,
      remediation: 'Restart Claude Code to activate telemetry',
    };
  }
  return {
    id: 'otel-settings', name: 'OTEL Settings', status: 'pass',
    message: sessionTelemetry ? `${matched}; telemetry is on in this session` : matched,
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

function checkOtelHeadersHelper(projectDir, dataDir, { telemetryWithheld = false, installScope } = {}) {
  if (telemetryWithheld) {
    return {
      id: 'otel-headers-helper',
      name: 'OTEL Headers Helper',
      status: 'skip',
      message: `Not applicable: Prism does not configure OTEL at the ${installScope} install scope on this Claude Code`,
      remediation: null,
    };
  }
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

// ─── Check 5: Install Context ───

function checkInstallContext({
  pluginRoot,
  dataDir,
  inspected = inspectClaudeContext({ pluginRoot, dataDir }),
} = {}) {
  const base = { id: 'install-context', name: 'Install Context' };
  if (inspected.error) {
    return {
      ...base, status: 'fail',
      message: `Claude config root is invalid: ${inspected.error}`,
      remediation: `Set ${CONFIG_DIR_ENV} to an absolute path, or unset it, then restart Claude Code`,
    };
  }

  const { paths, context } = inspected;
  const root = `Claude config root ${paths.configRoot} `
    + `(source: ${paths.source === 'env' ? CONFIG_DIR_ENV : 'default'})`;
  if (context.status === 'mismatch') {
    return {
      ...base, status: 'fail',
      message: `${root}; ${describePluginContext(context)}; `
        + `plugin root ${context.pluginRoot}; plugin data ${context.dataDir}`,
      remediation: 'Make sure this command runs under the same CLAUDE_CONFIG_DIR as the Claude Code '
        + 'session that installed the plugin, then restart Claude Code',
    };
  }
  if (inspected.pluginCacheDirEnv) {
    return {
      ...base, status: 'warn',
      message: `${root}; ${PLUGIN_CACHE_DIR_ENV} is set to ${inspected.pluginCacheDirEnv}, `
        + 'which Prism does not support',
      remediation: `Unset ${PLUGIN_CACHE_DIR_ENV}; setup, config, and uninstall refuse while it is set`,
    };
  }
  if (context.status === 'not-checked') {
    return {
      ...base, status: 'skip',
      message: `${root}; install context not checked (${context.reason})`,
      remediation: null,
    };
  }
  return {
    ...base, status: 'pass',
    message: `${root}; ${context.mode} install matches plugin data ${context.dataDir}`,
    remediation: null,
  };
}

/**
 * Resolve the hook debug log the same way lib/env.js does, without loading that
 * module: env.js snapshots the config at require time, so requiring it here
 * would turn a malformed config into a module-load crash instead of the
 * reported failure this entrypoint already produces. Doctor's own --data-dir
 * wins, so the reported path matches the directory being diagnosed.
 */
function debugLogPath(dataDir) {
  const base = dataDir
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.prism', 'logs');
  return path.join(base, 'debug.log');
}

// ─── Runner ───

function summarize(checks) {
  return {
    passed: checks.filter(c => c.status === 'pass').length,
    warnings: checks.filter(c => c.status === 'warn').length,
    failed: checks.filter(c => c.status === 'fail').length,
    skipped: checks.filter(c => c.status === 'skip').length,
  };
}

function skippedForInvalidRoot(id, name) {
  return {
    id, name, status: 'skip',
    message: `Not checked: ${CONFIG_DIR_ENV} is invalid`,
    remediation: null,
  };
}

async function runChecks({
  projectDir,
  dataDir,
  env = process.env,
  hostVersion,
  pluginRoot = path.resolve(__dirname, '..'),
} = {}) {
  const config = getConfig();
  const inspected = inspectClaudeContext({ pluginRoot, dataDir });
  const installContext = checkInstallContext({ pluginRoot, dataDir, inspected });
  if (inspected.error) {
    const checks = [
      checkApiKey(config),
      skippedForInvalidRoot('otel-settings', 'OTEL Settings'),
      await checkIngestConnectivity(config),
      skippedForInvalidRoot('otel-headers-helper', 'OTEL Headers Helper'),
      installContext,
    ];
    return {
      version: '1.0',
      timestamp: new Date().toISOString(),
      checks,
      summary: summarize(checks),
      notices: [],
    };
  }
  const telemetryScope = resolveTelemetryScope({ projectDir, pluginRoot, hostVersion });
  const sessionTelemetry = readSessionTelemetry(env);
  const telemetryWithheld = Boolean(telemetryScope.scope) && !telemetryScope.canEnableTelemetry;
  const checks = [
    checkApiKey(config),
    checkOtelProjection(projectDir, dataDir, {
      hostVersion: telemetryScope.hostVersion,
      sessionTelemetry,
      pluginRoot,
    }),
    await checkIngestConnectivity(config),
    checkOtelHeadersHelper(projectDir, dataDir, {
      telemetryWithheld,
      installScope: telemetryScope.scope,
    }),
    installContext,
  ];
  const summary = summarize(checks);

  // Debug logging has no `/prism:config` field on purpose. Doctor still reports
  // it when it is on, so an install that quietly accumulates hook diagnostics is
  // discoverable. A disabled toggle produces no notice at all.
  const notices = [];
  const otherRoots = verifyOtherRoots({ configRoot: inspected.paths.configRoot });
  for (const entry of otherRoots.roots) {
    notices.push(`Other Claude config root ${entry.root}: ${entry.state} (${entry.detail})`);
  }
  if (otherRoots.inventory.condition === 'corrupt') {
    notices.push(
      `The install inventory is corrupt (${otherRoots.inventory.reason}); `
        + 'uninstall preserves ~/.prism until it is repaired');
  } else if (otherRoots.inventory.condition === 'overflow') {
    notices.push('The install inventory is full; uninstall preserves ~/.prism');
  }
  if (config.debug === true) {
    notices.push('Debug logging is enabled in ~/.prism/config.json; hook diagnostics append to '
      + debugLogPath(dataDir));
  }

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    checks,
    summary,
    notices,
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

  const notices = Array.isArray(results && results.notices) ? results.notices : [];
  if (notices.length > 0) {
    lines.push('', '**Notices:**');
    for (const notice of notices) lines.push(`- ${notice}`);
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
  checkInstallContext,
  checkOtelHeadersHelper,
  main,
  renderReport,
  runChecks,
};
