const config = require('./config');
const { isSupportedApiKey } = require('./api-key');
const { notifySetupComplete } = require('./notify');

async function cacheConfig(apiKey, output = console) {
  if (!isSupportedApiKey(apiKey)) return 2;

  const resolved = await config.ensureCache(apiKey);
  if (resolved.source === 'auth-error') {
    output.error(`ERROR: config endpoint rejected the API key (HTTP ${resolved.auth_status}).`);
    return 2;
  }

  output.log(`Config cached (${resolved.source}): ${resolved.ingest_url}`);
  if (resolved._changed && resolved._changed.length > 0) {
    output.log('URLs updated:');
    for (const change of resolved._changed) {
      output.log(`  ${change.key}: ${change.from} → ${change.to}`);
    }
  }
  if (resolved.source === 'fallback') {
    output.log('WARNING: config endpoint unreachable — using hardcoded prod URLs. If the key is for a non-prod environment, telemetry will go to the wrong place.');
  }
  return 0;
}

async function notifyDashboard(apiKey, output = console) {
  const ok = await notifySetupComplete(apiKey);
  if (!ok) {
    output.log('(setup-complete ping skipped — dashboard will fall back to first-prompt detection)');
  }
  return 0;
}

async function main() {
  const action = process.argv[2];
  const apiKey = process.env.PRISM_API_KEY || '';

  if (action === 'cache') return cacheConfig(apiKey);
  if (action === 'notify') return notifyDashboard(apiKey);
  return 2;
}

if (require.main === module) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch(() => { process.exitCode = 1; });
}

module.exports = { cacheConfig, notifyDashboard };
