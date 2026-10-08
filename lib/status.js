#!/usr/bin/env node
/**
 * Prism Status — render the effective plugin configuration and connectivity.
 *
 * CLI: node lib/status.js [--project-dir PATH] [--data-dir PATH]
 */

const fs = require('fs');
const path = require('path');
const {
  CONFIG_DIR_ENV,
  PLUGIN_CACHE_DIR_ENV,
  describePluginContext,
  inspectClaudeContext,
} = require('./claude-paths');
const {
  OTEL_HEADERS_HELPER_KEY,
  buildExpectedOtelEnv,
  checkOtelSettings,
  detectInstallScope,
  inspectManagedOtelHeadersHelper,
  optOutSettingsPath,
  readEffectiveSetting,
  readEffectiveSettings,
  resolveTelemetryScope,
} = require('./settings');
const hostTelemetry = require('./host-telemetry');
const { getConfig, isSupportedIngestUrl, readConfig } = require('./config');
const { getConfigField } = require('./config-fields');
const { healthCheck } = require('./ingest');
const { verifyOtherRoots } = require('./install-inventory');

function hasValue(value) {
  return typeof value === 'string' && value.length > 0;
}

// Counts, state names, and reason codes only — never a remote host, an
// owner path, a repository name, a branch, a commit SHA, a fingerprint, a
// path, or a payload.
function formatGitEvidenceLines(gitEvidence) {
  if (!gitEvidence || !gitEvidence.capability || !gitEvidence.queue) return [];
  const { capability, queue } = gitEvidence;
  if (queue.pending === 0 && queue.terminal === 0 && capability.state === 'supported' && !capability.stale) {
    return ['**Git evidence:** ready'];
  }
  const dormant = capability.state !== 'supported' || capability.stale;
  const status = dormant ? `dormant (capability: ${capability.state})` : 'active';
  const reasons = Object.entries(queue.terminalReasons || {})
    .map(([reason, count]) => `${reason} ${count}`)
    .join(', ');
  const queueLine = `**Git evidence queue:** ${queue.pending} pending, ${queue.terminal} settled${reasons ? ` (${reasons})` : ''}`;
  return [`**Git evidence:** ${status}`, queueLine];
}

function formatSettingsSource(effectiveSettings, key) {
  const scope = effectiveSettings.sources[key];
  if (!scope) return 'not set';
  return `${scope} (${effectiveSettings.files[scope]})`;
}

function formatEndpoint(effectiveSettings, key) {
  const value = effectiveSettings.env[key];
  return `${hasValue(value) ? value : 'not set'} (source: ${formatSettingsSource(effectiveSettings, key)})`;
}

function inspectOtelHeadersHelper({ projectDir, dataDir } = {}) {
  const effective = readEffectiveSetting(OTEL_HEADERS_HELPER_KEY, projectDir);
  const managed = inspectManagedOtelHeadersHelper(dataDir);
  const configuredPath = typeof effective.value === 'string' ? effective.value : null;
  return {
    ...managed,
    effective,
    configuredPath,
  };
}

function formatHelperSource(helperDiagnostic) {
  const { effective } = helperDiagnostic;
  if (!effective.source) return 'not set';
  return `${effective.source} (${effective.files[effective.source]})`;
}

function formatHelperValue(value) {
  if (value === undefined) return 'not set';
  if (typeof value === 'string') return value.length > 0 ? value : 'invalid empty string';
  if (value === null) return 'invalid null';
  return `invalid ${Array.isArray(value) ? 'array' : typeof value}`;
}

function formatMismatchSource(effectiveSettings, helperDiagnostic, key) {
  if (key === OTEL_HEADERS_HELPER_KEY && helperDiagnostic) {
    return formatHelperSource(helperDiagnostic);
  }
  return formatSettingsSource(effectiveSettings, key);
}

function formatArtifact(artifact) {
  const label = (value) => {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return 'unknown';
  };
  const detail = [
    `exists=${label(artifact.exists)}`,
    `regular file=${label(artifact.regularFile)}`,
    `not symlink=${label(artifact.notSymlink)}`,
    `safe path=${label(artifact.safePath)}`,
    `current UID (where supported)=${label(artifact.ownedByCurrentUser)}`,
    `exact mode 0700=${label(artifact.exactMode)}`,
    `executable=${label(artifact.executable)}`,
    `bundled bytes=${label(artifact.matchesBundledSource)}`,
  ];
  if (artifact.reason) detail.push(`reason=${artifact.reason}`);
  return detail.join(', ');
}

function formatHelperPathChain(diagnostic) {
  const label = (value) => {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return 'unknown';
  };
  return [
    `data dir: exists=${label(diagnostic.dataDirExists)}, ` +
      `directory=${label(diagnostic.dataDirDirectory)}, ` +
      `not symlink=${label(diagnostic.dataDirNotSymlink)}`,
    `bin dir: exists=${label(diagnostic.binDirExists)}, ` +
      `directory=${label(diagnostic.binDirDirectory)}, ` +
      `not symlink=${label(diagnostic.binDirNotSymlink)}`,
  ].join('; ');
}

function helperHasEffectiveConflict(diagnostic) {
  return Boolean(
    diagnostic
      && diagnostic.expectedPath
      && diagnostic.effective.source
      && diagnostic.effective.value !== diagnostic.expectedPath,
  );
}

function formatHelperConflict(diagnostic) {
  const source = formatHelperSource(diagnostic);
  return `Prism preserved the effective OTEL headers helper from ${source}; ` +
    '`/prism:setup` will not overwrite that setting. Review or remove that setting explicitly, ' +
    'then rerun `/prism:setup KEY` and restart Claude Code.';
}

function formatConfigSource(rawConfig, key) {
  if (Object.prototype.hasOwnProperty.call(rawConfig, key)) return '~/.prism/config.json';
  const field = getConfigField(key);
  if (field && field.legacyNames.some((legacyName) =>
    Object.prototype.hasOwnProperty.call(rawConfig, legacyName))) {
    return '~/.prism/config.json';
  }
  return key === 'apiKey' || (field && field.defaultValue !== null) ? 'default' : 'not set';
}

function formatClaudeContextLines(claudeContext) {
  if (!claudeContext) return [];
  const lines = [];
  if (claudeContext.error) {
    lines.push(`**Claude config root:** invalid (${claudeContext.error})`);
  } else {
    const { paths, context } = claudeContext;
    lines.push(
      `**Claude config root:** ${paths.configRoot} ` +
        `(source: ${paths.source === 'env' ? CONFIG_DIR_ENV : 'default'})`,
    );
    if (context.status === 'ok') {
      lines.push(`**Install context:** ok (${context.mode} install; plugin data ${context.dataDir})`);
    } else if (context.status === 'not-checked') {
      lines.push(`**Install context:** not checked (${context.reason})`);
    } else {
      lines.push(
        `**Install context:** mismatch (${describePluginContext(context)}; ` +
          `plugin root ${context.pluginRoot}; plugin data ${context.dataDir})`,
      );
    }
  }
  lines.push(...formatOtherRootLines(claudeContext.roots));
  if (claudeContext.pluginCacheDirEnv) {
    lines.push(
      `**${PLUGIN_CACHE_DIR_ENV}:** set to ${claudeContext.pluginCacheDirEnv}; not supported. ` +
        'Setup, config, and uninstall refuse until it is unset.',
    );
  }
  return lines;
}

// Read-only report of the other config roots (never written to) and of the
// inventory that lists them.
function formatOtherRootLines(verification) {
  if (!verification) return [];
  const lines = [];
  if (verification.roots.length === 0) {
    lines.push('**Other Claude config roots:** none');
  } else {
    lines.push('**Other Claude config roots:**');
    for (const entry of verification.roots) {
      lines.push(`- ${entry.root}: ${entry.state} (${entry.detail})`);
    }
  }
  const { condition, reason } = verification.inventory;
  if (condition === 'corrupt') {
    lines.push(`**Install inventory:** corrupt (${reason}); Prism preserves ~/.prism until it is repaired.`);
  } else if (condition === 'overflow') {
    lines.push('**Install inventory:** full; some config roots are not recorded, so Prism preserves ~/.prism.');
  }
  return lines;
}

function renderStatus(inputs) {
  const {
    claudeContext,
    config,
    rawConfig,
    installScope,
    effectiveSettings,
    expectedOtel,
    otelStatus,
    helperDiagnostic,
    health,
    gitEvidence,
    hostVersion,
    sessionTelemetry,
    optOutFile,
  } = inputs;
  const apiKeyConfigured = hasValue(config.apiKey);
  const ingestUrl = hasValue(config.ingest_url) ? config.ingest_url : 'not configured';
  const ingestUrlSupported = isSupportedIngestUrl(config.ingest_url);
  const dashboardUrl = hasValue(config.dashboard_url) ? config.dashboard_url : 'not configured';
  const expectedLogs = expectedOtel && expectedOtel.otelEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const expectedMetrics = expectedOtel && expectedOtel.otelEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const effectiveMismatches = [...otelStatus.mismatches];
  const helperHealthy = !helperDiagnostic
    || (helperDiagnostic.expectedPath !== null
      && helperDiagnostic.configuredPath === helperDiagnostic.expectedPath
      && helperDiagnostic.ok === true);
  if (!helperHealthy && !effectiveMismatches.includes(OTEL_HEADERS_HELPER_KEY)) {
    effectiveMismatches.push(OTEL_HEADERS_HELPER_KEY);
  }
  const effectiveOtelOk = otelStatus.ok && helperHealthy;
  const lines = ['**Prism Status**', ''];

  if (apiKeyConfigured) {
    lines.push(`**Prism API key:** present (source: ${formatConfigSource(rawConfig, 'apiKey')})`);
  } else {
    lines.push(`**Prism API key:** missing (source: ${formatConfigSource(rawConfig, 'apiKey')})`);
    lines.push('Run `/prism:setup KEY`. Get your key at https://dashboard.optra-prism.com/setup');
  }

  lines.push(
    '',
    `**Ingest URL:** ${ingestUrl} (source: ${formatConfigSource(rawConfig, 'ingest_url')})`,
    `**Dashboard URL:** ${dashboardUrl} (source: ${formatConfigSource(rawConfig, 'dashboard_url')})`,
    `**Install scope:** ${installScope || 'not detected'}`,
    ...formatClaudeContextLines(claudeContext),
  );
  if (hostVersion !== undefined) {
    lines.push(`**Claude Code:** ${hostVersion || 'version unknown'}`);
  }

  if (otelStatus.telemetryWithheld) {
    lines.push('', ...formatWithheldTelemetryLines(otelStatus, sessionTelemetry));
    appendRuntimeLines(lines, { config, rawConfig, health, gitEvidence, apiKeyConfigured, ingestUrlSupported });
    return lines.join('\n');
  }

  lines.push(
    '',
    `**Effective OTEL Logs:** ${formatEndpoint(effectiveSettings, 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')}`,
    `**Expected OTEL Logs:** ${expectedLogs || 'unavailable until Prism is configured'}`,
    `**Effective OTEL Metrics:** ${formatEndpoint(effectiveSettings, 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT')}`,
    `**Expected OTEL Metrics:** ${expectedMetrics || 'unavailable until Prism is configured'}`,
  );

  if (helperDiagnostic) {
    lines.push(
      `**Disk-effective OTEL Headers Helper:** ${formatHelperValue(helperDiagnostic.effective.value)} ` +
        `(source: ${formatHelperSource(helperDiagnostic)})`,
      `**Expected Prism OTEL Headers Helper:** ${helperDiagnostic.expectedPath || `unavailable (${helperDiagnostic.expectedPathError})`}`,
      `**Prism-managed helper artifact:** ${formatArtifact(helperDiagnostic)}`,
      `**Prism-managed helper path chain:** ${formatHelperPathChain(helperDiagnostic)}`,
      '**Helper source coverage:** user/project/local settings on disk only; ' +
        'managed settings and CLI overrides are outside this reader.',
    );
    if (helperHasEffectiveConflict(helperDiagnostic)) {
      lines.push(`**Helper setting conflict:** ${formatHelperConflict(helperDiagnostic)}`);
    }
  }

  if (hasValue(config.ingest_url) && !ingestUrlSupported) {
    lines.push(
      '**Ingest URL safety:** unsupported; use HTTPS, or HTTP on loopback, ' +
        'without credentials, query, or fragment.',
    );
  }

  if (effectiveOtelOk) {
    lines.push('**OTEL settings:** configured on disk.');
    const sessionLine = formatSessionTelemetryLine(sessionTelemetry);
    if (sessionLine) lines.push(sessionLine);
    lines.push('**Restart:** Restart Claude Code if the API key or ingest_url changed since launch.');
  } else {
    lines.push(`**OTEL settings:** out of sync (${effectiveMismatches.length} value(s)).`);
    for (const key of effectiveMismatches) {
      lines.push(
        `- ${key} (effective source: ${formatMismatchSource(effectiveSettings, helperDiagnostic, key)})`,
      );
    }
    if (!helperHasEffectiveConflict(helperDiagnostic)) {
      lines.push('Run `/prism:setup KEY` (or reapply `ingest_url` with `/prism:config`), then restart Claude Code.');
    } else if (effectiveMismatches.some((key) => key !== OTEL_HEADERS_HELPER_KEY)) {
      lines.push(
        'Run `/prism:setup KEY` to reproject non-helper OTEL values; Prism will preserve ' +
          'the conflicting helper. Then restart Claude Code.',
      );
    }
  }

  if (otelStatus.assistantResponseConflict) {
    const { key, source, installScope } = otelStatus.assistantResponseConflict;
    lines.push(
      `**Assistant-response setting conflict:** ${key} is "0" from the ${source} settings layer, ` +
        `which takes precedence over the ${installScope} scope Prism manages here; ` +
        '`/prism:setup` cannot fix this by writing to that scope. Review or remove it in the ' +
        `${source} settings file directly, then restart Claude Code.`,
    );
  }

  if (optOutFile) lines.push(`**Run without Prism:** \`claude --settings ${optOutFile}\``);

  appendRuntimeLines(lines, { config, rawConfig, health, gitEvidence, apiKeyConfigured, ingestUrlSupported });
  return lines.join('\n');
}

function formatSessionTelemetryLine(sessionTelemetry) {
  if (!sessionTelemetry) return null;
  if (!sessionTelemetry.observable) {
    return '**Session telemetry:** not observable outside a Claude Code session; settings on disk only.';
  }
  if (sessionTelemetry.enabled) return '**Session telemetry:** on in this session.';
  return '**Session telemetry:** off in this session. Restart Claude Code to activate telemetry.';
}

function formatWithheldTelemetryLines(otelStatus, sessionTelemetry) {
  const scope = { scope: otelStatus.installScope, hostVersion: otelStatus.hostVersion };
  if (sessionTelemetry && sessionTelemetry.enabled) {
    return [
      '**Telemetry:** on in this session from settings outside the Prism install scope; ' +
        'Prism does not manage its destination.',
      hostTelemetry.withheldTelemetrySummary(scope),
    ];
  }
  return [
    '**Telemetry:** not collected in this project.',
    hostTelemetry.withheldTelemetrySummary(scope),
    hostTelemetry.withheldTelemetryRemediation(scope),
  ];
}

function appendRuntimeLines(lines, {
  config,
  rawConfig,
  health,
  gitEvidence,
  apiKeyConfigured,
  ingestUrlSupported,
}) {
  let healthStatus;
  if (health && health.reachable) {
    healthStatus = `reachable (HTTP ${health.httpStatus || 'unknown'})`;
  } else {
    healthStatus = `unreachable${health && health.error ? ` (${health.error})` : ''}`;
  }

  const promptCapture = apiKeyConfigured && ingestUrlSupported
    ? 'prerequisites present; authentication and capture result not checked'
    : 'not configured';

  let realtimeSummary;
  if (config.show_realtime_summary === true) realtimeSummary = 'On';
  else if (config.show_realtime_summary === false) realtimeSummary = 'Off';
  else realtimeSummary = `invalid value (${JSON.stringify(config.show_realtime_summary)})`;

  lines.push(
    '',
    `**Ingest health endpoint:** ${healthStatus}`,
    `**Prompt capture:** ${promptCapture}`,
    `**Realtime summary setting:** ${realtimeSummary} (source: ${formatConfigSource(rawConfig, 'show_realtime_summary')})`,
    '**Session:** Realtime session totals are stored in isolated, hashed runtime records.',
    ...formatGitEvidenceLines(gitEvidence),
    '',
    'Run `/prism:help` for all commands.',
  );
  if (hasValue(config.dashboard_url)) {
    lines.push(`**Next:** open ${config.dashboard_url.replace(/\/+$/, '')}/ for realtime coaching, PRISM scores, and insights.`);
  }
}

function parseArgs(argv) {
  const args = {
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    dataDir: null,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option !== '--project-dir' && option !== '--data-dir') {
      throw new TypeError(`Unknown or incomplete argument: ${option}`);
    }
    if (seen.has(option)) {
      throw new TypeError(`Duplicate argument: ${option}`);
    }
    const value = argv[i + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new TypeError(`Unknown or incomplete argument: ${option}`);
    }
    seen.add(option);
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
    process.stderr.write(`[prism:status] ${err.message}\n`);
    return 2;
  }

  try {
    const config = getConfig();
    const rawConfig = readConfig();
    const pluginRoot = path.resolve(__dirname, '..');
    const claudeContext = inspectClaudeContext({ pluginRoot, dataDir: args.dataDir });
    if (!claudeContext.error) {
      claudeContext.roots = verifyOtherRoots({ configRoot: claudeContext.paths.configRoot });
    }
    if (claudeContext.error) {
      process.stdout.write(`${[
        '**Prism Status**',
        '',
        ...formatClaudeContextLines(claudeContext),
        '',
        `Settings were not inspected. Set ${CONFIG_DIR_ENV} to an absolute path, or unset it, then rerun.`,
      ].join('\n')}\n`);
      return 1;
    }
    const telemetryScope = resolveTelemetryScope({ projectDir: args.projectDir, pluginRoot });
    const effectiveSettings = readEffectiveSettings(args.projectDir, {
      projectTelemetryIgnored: telemetryScope.projectTelemetryIgnored,
    });
    const expectedOtel = buildExpectedOtelEnv();
    const otelStatus = checkOtelSettings({
      projectDir: args.projectDir,
      dataDir: args.dataDir,
      pluginRoot,
      hostVersion: telemetryScope.hostVersion,
    });
    const helperDiagnostic = inspectOtelHeadersHelper({
      projectDir: args.projectDir,
      dataDir: args.dataDir,
    });
    const installScope = detectInstallScope(args.projectDir, pluginRoot);
    let optOutFile = null;
    if (installScope === 'user' && args.dataDir && !otelStatus.telemetryWithheld) {
      const candidate = optOutSettingsPath(args.dataDir);
      if (fs.existsSync(candidate)) optOutFile = candidate;
    }
    const health = await healthCheck(config.ingest_url);
    let gitEvidence = null;
    try {
      const { capabilityDiagnostics } = require('./git-evidence-capability');
      const { evidenceCounts } = require('./git-evidence-outbox');
      gitEvidence = { capability: capabilityDiagnostics(), queue: evidenceCounts() };
    } catch {}
    process.stdout.write(renderStatus({
      claudeContext,
      config,
      rawConfig,
      installScope,
      effectiveSettings,
      expectedOtel,
      otelStatus,
      helperDiagnostic,
      health,
      gitEvidence,
      hostVersion: telemetryScope.hostVersion,
      sessionTelemetry: hostTelemetry.readSessionTelemetry(),
      optOutFile,
    }) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`[prism:status] Fatal: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = {
  formatArtifact,
  formatHelperConflict,
  formatHelperPathChain,
  formatOtherRootLines,
  helperHasEffectiveConflict,
  inspectOtelHeadersHelper,
  main,
  renderStatus,
};
