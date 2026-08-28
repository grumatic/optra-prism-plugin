#!/usr/bin/env node
/**
 * Prism Status — render the effective plugin configuration and connectivity.
 *
 * CLI: node lib/status.js [--project-dir PATH] [--data-dir PATH]
 */

const path = require('path');
const {
  OTEL_HEADERS_HELPER_KEY,
  buildExpectedOtelEnv,
  checkOtelSettings,
  detectInstallScope,
  inspectManagedOtelHeadersHelper,
  readEffectiveSetting,
  readEffectiveSettings,
} = require('./settings');
const { getConfig, isSupportedIngestUrl, readConfig } = require('./config');
const { getConfigField } = require('./config-fields');
const { healthCheck } = require('./ingest');

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

function renderStatus(inputs) {
  const {
    config,
    rawConfig,
    installScope,
    effectiveSettings,
    expectedOtel,
    otelStatus,
    helperDiagnostic,
    health,
    gitEvidence,
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
  return lines.join('\n');
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
    const effectiveSettings = readEffectiveSettings(args.projectDir);
    const expectedOtel = buildExpectedOtelEnv();
    const otelStatus = checkOtelSettings({
      projectDir: args.projectDir,
      dataDir: args.dataDir,
    });
    const helperDiagnostic = inspectOtelHeadersHelper({
      projectDir: args.projectDir,
      dataDir: args.dataDir,
    });
    const installScope = detectInstallScope(args.projectDir);
    const health = await healthCheck(config.ingest_url);
    let gitEvidence = null;
    try {
      const { capabilityDiagnostics } = require('./git-evidence-capability');
      const { evidenceCounts } = require('./git-evidence-outbox');
      gitEvidence = { capability: capabilityDiagnostics(), queue: evidenceCounts() };
    } catch {}
    process.stdout.write(renderStatus({
      config,
      rawConfig,
      installScope,
      effectiveSettings,
      expectedOtel,
      otelStatus,
      helperDiagnostic,
      health,
      gitEvidence,
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
  helperHasEffectiveConflict,
  inspectOtelHeadersHelper,
  main,
  renderStatus,
};
