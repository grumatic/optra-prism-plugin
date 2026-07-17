const test = require('node:test');
const assert = require('node:assert');

const { renderStatus } = require('../lib/status');

test('renders configured status with the effective realtime source', () => {
  const output = renderStatus({
    apiKeyConfigured: true,
    projectDir: '/workspace/project',
    scope: 'project',
    scopeWarnings: [],
    realtimeSummary: { value: false, source: 'legacy' },
    ingestUrl: 'https://ingest.example.test',
    invalidIngestOverride: false,
    otelLogsEndpoint: 'https://ingest.example.test/v1/logs',
    otelMetricsEndpoint: 'https://ingest.example.test/v1/metrics',
    ingestConnected: true,
  });

  assert.equal(output, [
    '**Prism Status**',
    '',
    '**Prism API key:** configured',
    '',
    '**Scope:** project (/workspace/project/.claude/settings.local.json) — active only in this project.',
    '',
    '**Realtime summary:** Off (source: legacy)',
    '',
    '**Ingest URL:** https://ingest.example.test',
    '**OTEL Logs:** https://ingest.example.test/v1/logs (expected: https://ingest.example.test/v1/logs)',
    '**OTEL Metrics:** https://ingest.example.test/v1/metrics (expected: https://ingest.example.test/v1/metrics)',
    '**Ingest connectivity:** connected',
    '',
    '**Active features:** OTel telemetry, PRISM gate, and prompt capture are on.',
    '**Session:** Realtime session totals are stored in isolated, hashed runtime records.',
    '',
    'Run `/prism:help` for all commands.',
    '**Next:** open https://dashboard.optra-prism.com/ for realtime coaching, PRISM scores, and insights.',
  ].join('\n'));
});

test('renders unconfigured status with invalid-option and shared-settings warnings', () => {
  const output = renderStatus({
    apiKeyConfigured: false,
    projectDir: '/workspace/project',
    scope: 'none',
    scopeWarnings: ['OTEL vars found in /workspace/project/.claude/settings.json (shared, likely checked in). This can leak your Prism API key — remove them manually.'],
    realtimeSummary: {
      value: true,
      source: 'env-official',
      error: 'Invalid boolean value from env-official; using the safe default.',
    },
    ingestUrl: null,
    invalidIngestOverride: true,
    otelLogsEndpoint: undefined,
    otelMetricsEndpoint: undefined,
    ingestConnected: false,
  });

  assert.equal(output, [
    '**Prism Status**',
    '',
    '**Prism API key:** not configured',
    'Run `/prism:setup prism_YOUR_KEY`. Get your key at https://dashboard.optra-prism.com/setup',
    '',
    '**Scope:** none — Prism is not activated yet. Run `/prism:setup prism_YOUR_KEY`.',
    '**WARNING:** OTEL vars found in /workspace/project/.claude/settings.json (shared, likely checked in). This can leak your Prism API key — remove them manually.',
    '',
    '**Error:** Invalid boolean value from env-official; using the safe default.',
    '**Realtime summary:** On (source: env-official)',
    '',
    '**Ingest URL:** Invalid explicit override. Fix or remove PRISM_INGEST_URL or ~/.prism/config.json.ingest_url.',
    '**OTEL Logs:** unavailable (ingest override is invalid)',
    '**OTEL Metrics:** unavailable (ingest override is invalid)',
    '**Ingest connectivity:** not checked (ingest override is invalid)',
    '',
    '**Active features:** OTel telemetry, PRISM gate, and prompt capture are on.',
    '**Session:** Realtime session totals are stored in isolated, hashed runtime records.',
    '',
    'Run `/prism:help` for all commands.',
    '**Next:** open https://dashboard.optra-prism.com/ for realtime coaching, PRISM scores, and insights.',
  ].join('\n'));
});
