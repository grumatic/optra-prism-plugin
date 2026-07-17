#!/usr/bin/env node
/**
 * Prism Status — render the effective plugin configuration and connectivity.
 *
 * CLI: node lib/status.js --project-dir PATH
 */

const { detectActiveScope, readApiKey } = require('./settings');
const { resolveShowRealtimeSummary, resolveStringOption } = require('./options');
const { getConfig, getIngestOverride } = require('./config');
const { healthCheck } = require('./ingest');

function resolveApiKey() {
  return process.env.PRISM_API_KEY
    || process.env.PRISM_GCK_KEY
    || resolveStringOption({
      officialEnv: 'CLAUDE_PLUGIN_OPTION_APIKEY',
      compatEnv: 'CLAUDE_PLUGIN_OPTION_apiKey',
      legacyKey: 'apiKey',
      defaultValue: readApiKey(),
    }).value;
}

function formatScope(scope, projectDir) {
  switch (scope) {
    case 'user':
      return '**Scope:** user (`~/.claude/settings.json`) — active in every project.';
    case 'project':
      return `**Scope:** project (${projectDir}/.claude/settings.local.json) — active only in this project.`;
    case 'both':
      return '**Scope:** both — OTEL vars exist in both user and project scopes. Run `/prism:setup` to pick one.';
    default:
      return '**Scope:** none — Prism is not activated yet. Run `/prism:setup prism_YOUR_KEY`.';
  }
}

function renderStatus(inputs) {
  const {
    apiKeyConfigured,
    projectDir,
    scope,
    scopeWarnings = [],
    realtimeSummary,
    ingestUrl,
    invalidIngestOverride,
    otelLogsEndpoint,
    otelMetricsEndpoint,
    ingestConnected,
  } = inputs;
  const lines = ['**Prism Status**', ''];

  if (apiKeyConfigured) {
    lines.push('**Prism API key:** configured');
  } else {
    lines.push('**Prism API key:** not configured');
    lines.push('Run `/prism:setup prism_YOUR_KEY`. Get your key at https://dashboard.optra-prism.com/setup');
  }

  lines.push('', formatScope(scope, projectDir));
  for (const warning of scopeWarnings) lines.push(`**WARNING:** ${warning}`);

  if (realtimeSummary.error) lines.push('', `**Error:** ${realtimeSummary.error}`);
  else lines.push('');
  lines.push(`**Realtime summary:** ${realtimeSummary.value ? 'On' : 'Off'} (source: ${realtimeSummary.source})`);

  if (invalidIngestOverride) {
    lines.push('', '**Ingest URL:** Invalid explicit override. Fix or remove PRISM_INGEST_URL or ~/.prism/config.json.ingest_url.');
    lines.push('**OTEL Logs:** unavailable (ingest override is invalid)');
    lines.push('**OTEL Metrics:** unavailable (ingest override is invalid)');
    lines.push('**Ingest connectivity:** not checked (ingest override is invalid)');
  } else {
    lines.push('', `**Ingest URL:** ${ingestUrl}`);
    lines.push(`**OTEL Logs:** ${otelLogsEndpoint || 'not set'} (expected: ${ingestUrl}/v1/logs)`);
    lines.push(`**OTEL Metrics:** ${otelMetricsEndpoint || 'not set'} (expected: ${ingestUrl}/v1/metrics)`);
    lines.push(`**Ingest connectivity:** ${ingestConnected ? 'connected' : 'unreachable'}`);
  }

  lines.push(
    '',
    '**Active features:** OTel telemetry, PRISM gate, and prompt capture are on.',
    '**Session:** Realtime session totals are stored in isolated, hashed runtime records.',
    '',
    'Run `/prism:help` for all commands.',
    '**Next:** open https://dashboard.optra-prism.com/ for realtime coaching, PRISM scores, and insights.',
  );
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
    const apiKey = resolveApiKey();
    const { scope, warnings } = detectActiveScope(args.projectDir);
    const realtimeSummary = resolveShowRealtimeSummary();
    const invalidIngestOverride = getIngestOverride() === null;
    const config = getConfig(apiKey);
    const ingestConnected = invalidIngestOverride ? false : await healthCheck();
    process.stdout.write(renderStatus({
      apiKeyConfigured: Boolean(apiKey),
      projectDir: args.projectDir,
      scope,
      scopeWarnings: warnings,
      realtimeSummary,
      ingestUrl: config.ingest_url,
      invalidIngestOverride,
      otelLogsEndpoint: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      otelMetricsEndpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      ingestConnected,
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
