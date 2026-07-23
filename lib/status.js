#!/usr/bin/env node
/**
 * Prism Status — render the effective plugin configuration and connectivity.
 *
 * CLI: node lib/status.js --project-dir PATH
 */

const {
  buildExpectedOtelEnv,
  checkOtelSettings,
  detectInstallScope,
  readEffectiveSettings,
} = require('./settings');
const { getConfig, isSupportedIngestUrl, readConfig } = require('./config');
const { getConfigField } = require('./config-fields');
const { healthCheck } = require('./ingest');

function hasValue(value) {
  return typeof value === 'string' && value.length > 0;
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
    health,
  } = inputs;
  const apiKeyConfigured = hasValue(config.apiKey);
  const ingestUrl = hasValue(config.ingest_url) ? config.ingest_url : 'not configured';
  const ingestUrlSupported = isSupportedIngestUrl(config.ingest_url);
  const dashboardUrl = hasValue(config.dashboard_url) ? config.dashboard_url : 'not configured';
  const expectedLogs = expectedOtel && expectedOtel.otelEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const expectedMetrics = expectedOtel && expectedOtel.otelEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
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

  if (hasValue(config.ingest_url) && !ingestUrlSupported) {
    lines.push(
      '**Ingest URL safety:** unsupported; use HTTPS, or HTTP on loopback, ' +
        'without credentials, query, or fragment.',
    );
  }

  if (otelStatus.ok) {
    lines.push('**OTEL settings:** configured on disk.');
    lines.push('**Restart:** Restart Claude Code if the API key or ingest_url changed since launch.');
  } else {
    lines.push(`**OTEL settings:** out of sync (${otelStatus.mismatches.length} value(s)).`);
    for (const key of otelStatus.mismatches) {
      lines.push(`- ${key} (effective source: ${formatSettingsSource(effectiveSettings, key)})`);
    }
    lines.push('Run `/prism:setup KEY` (or reapply `ingest_url` with `/prism:config`), then restart Claude Code.');
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
    '',
    'Run `/prism:help` for all commands.',
  );
  if (hasValue(config.dashboard_url)) {
    lines.push(`**Next:** open ${config.dashboard_url.replace(/\/+$/, '')}/ for realtime coaching, PRISM scores, and insights.`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-dir' && argv[i + 1]) {
      args.projectDir = argv[++i];
    } else {
      throw new TypeError(`Unknown or incomplete argument: ${argv[i]}`);
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
    const otelStatus = checkOtelSettings({ projectDir: args.projectDir });
    const installScope = detectInstallScope(args.projectDir);
    const health = await healthCheck(config.ingest_url);
    process.stdout.write(renderStatus({
      config,
      rawConfig,
      installScope,
      effectiveSettings,
      expectedOtel,
      otelStatus,
      health,
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

module.exports = { renderStatus, main };
