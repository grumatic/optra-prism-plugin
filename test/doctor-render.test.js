const test = require('node:test');
const assert = require('node:assert');

const { renderReport } = require('../lib/doctor');

test('renders a mixed doctor report with auto-fixes and remediations', () => {
  const output = renderReport({
    checks: [
      { name: 'API Key', status: 'pass', message: 'Prism API key configured', remediation: null },
      { name: 'OTEL Scope', status: 'warn', message: 'OTEL vars exist in both user and project scopes', remediation: 'Run /prism:setup to consolidate to one scope' },
      { name: 'Config Cache', status: 'pass', message: 'Cache refreshed (was expired)', remediation: null },
      { name: 'Ingest Connectivity', status: 'fail', message: 'ingest: fail', remediation: 'Check network connectivity and verify the effective ingest URL' },
      { name: 'Process Env Sync', status: 'fail', message: '2 env var(s) out of sync', remediation: null },
    ],
    summary: { passed: 2, warnings: 1, failed: 2 },
    autoFixed: ['Refreshed expired config cache'],
  });

  assert.equal(output, [
    '**Prism Doctor** — 2 passed, 1 warnings, 2 failed',
    '',
    '| # | Check | Status | Details |',
    '|---|-------|--------|---------|',
    '| 1 | API Key | PASS | Prism API key configured |',
    '| 2 | OTEL Scope | WARN | OTEL vars exist in both user and project scopes |',
    '| 3 | Config Cache | PASS | Cache refreshed (was expired) |',
    '| 4 | Ingest Connectivity | FAIL | ingest: fail |',
    '| 5 | Process Env Sync | FAIL | 2 env var(s) out of sync |',
    '',
    '**Auto-fixed:**',
    '- Refreshed expired config cache',
    '',
    '**Issues:**',
    '1. **OTEL Scope:** OTEL vars exist in both user and project scopes',
    '   **Fix:** Run /prism:setup to consolidate to one scope',
    '2. **Ingest Connectivity:** ingest: fail',
    '   **Fix:** Check network connectivity and verify the effective ingest URL',
    '3. **Process Env Sync:** 2 env var(s) out of sync',
    '',
    'Run `/prism:help` for all commands.',
  ].join('\n'));
});

test('renders the all-healthy doctor report', () => {
  const output = renderReport({
    checks: [
      { name: 'API Key', status: 'pass', message: 'Prism API key configured', remediation: null },
      { name: 'OTEL Scope', status: 'pass', message: 'user scope (install: user)', remediation: null },
      { name: 'Config Cache', status: 'pass', message: 'Valid (env: production)', remediation: null },
      { name: 'Ingest Connectivity', status: 'pass', message: 'ingest: pass', remediation: null },
      { name: 'Process Env Sync', status: 'pass', message: 'All 10 OTEL env vars in sync', remediation: null },
    ],
    summary: { passed: 5, warnings: 0, failed: 0 },
    autoFixed: [],
  });

  assert.equal(output, [
    '**Prism Doctor** — 5 passed, 0 warnings, 0 failed',
    '',
    '| # | Check | Status | Details |',
    '|---|-------|--------|---------|',
    '| 1 | API Key | PASS | Prism API key configured |',
    '| 2 | OTEL Scope | PASS | user scope (install: user) |',
    '| 3 | Config Cache | PASS | Valid (env: production) |',
    '| 4 | Ingest Connectivity | PASS | ingest: pass |',
    '| 5 | Process Env Sync | PASS | All 10 OTEL env vars in sync |',
    '',
    'All checks passed. Your Prism configuration is healthy.',
    '',
    'Run `/prism:help` for all commands.',
  ].join('\n'));
});
