#!/usr/bin/env node
'use strict';

// Detached, fail-open model-catalog refresh started by session-start-handler.
// The cache feeds future Stop hooks, so SessionStart never waits on this
// process. Atomic temp-file + rename publication means a killed or failed
// refresh can never leave partial state; every failure keeps the existing
// last-known-good cache. The process self-limits with a hard guard above the
// request timeout. With config debug enabled, the outcome is appended to
// model-catalog-refresh.debug.log in CLAUDE_PLUGIN_DATA.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../../lib/config');
const { refreshCatalog } = require('../../lib/model-catalog');

// Config values are read from the authority file, never handed over as
// environment variables. Only host-provided paths arrive through env.
const config = getConfig();
const dataDir = process.env.CLAUDE_PLUGIN_DATA;

const report = (status) => {
  if (config.debug !== true) return;
  try {
    fs.appendFileSync(
      path.join(dataDir, 'model-catalog-refresh.debug.log'),
      `${new Date().toISOString()} ${status}\n`,
    );
  } catch {}
};

const guard = setTimeout(() => {
  report('kept-cache hook-time-budget');
  process.exit(0);
}, 1300);

refreshCatalog({
  ingestUrl: config.ingest_url,
  apiKey: config.apiKey,
  dataDir,
  timeoutMs: 1000,
}).then((status) => {
  clearTimeout(guard);
  report(status);
  process.exit(0);
}).catch(() => {
  clearTimeout(guard);
  report('kept-cache request-failed');
  process.exit(0);
});
