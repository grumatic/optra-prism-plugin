#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const settings = require('./settings');
const { isSupportedApiKey } = require('./api-key');
const { notifySetupComplete } = require('./notify');

const APPLY_USAGE = 'Usage: PRISM_API_KEY="<key>" node lib/setup.js apply [--scope user|project] [--project-dir <dir>] [--confirm]';

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
function getLocalConfigFile() {
  return path.join(os.homedir(), '.prism', 'config.json');
}


function readLocalConfig() {
  const file = getLocalConfigFile();
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('config must be a JSON object');
    }
    return value;
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw new Error('unable to read existing Prism config');
  }
}

function writeLocalConfig(apiKey) {
  const file = getLocalConfigFile();
  const prismDir = path.dirname(file);
  const existing = readLocalConfig();
  const merged = { ...existing, apiKey };

  if (!Object.prototype.hasOwnProperty.call(merged, 'prismThreshold')) {
    merged.prismThreshold = 4;
  }

  fs.mkdirSync(prismDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(prismDir, 0o700);
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function checkExistingKey(output = console) {
  try {
    output.log(isSupportedApiKey(readLocalConfig().apiKey) ? 'KEY_PRESENT' : 'KEY_ABSENT');
    return 0;
  } catch {
    output.log('KEY_ABSENT');
    return 0;
  }
}

function parseApplyArgs(argv) {
  const args = { scope: null, projectDir: null, confirm: false, checkExisting: false };

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--scope') {
      args.scope = argv[++index];
    } else if (value === '--project-dir') {
      args.projectDir = argv[++index];
    } else if (value === '--user') {
      args.scope = 'user';
    } else if (value === '--project') {
      args.scope = 'project';
    } else if (value === '--confirm') {
      args.confirm = true;
    } else if (value === '--check-existing') {
      args.checkExisting = true;
    } else {
      return null;
    }
  }

  if ((args.scope !== null && args.scope !== 'user' && args.scope !== 'project')
    || (argv.includes('--scope') && !args.scope)
    || (argv.includes('--project-dir') && !args.projectDir)) {
    return null;
  }
  return args;
}

function migrationReason(currentScope, targetScope) {
  return `Existing OTEL settings are in ${currentScope} scope; moving them to ${targetScope} scope changes telemetry coverage.`;
}

function otherActiveScopes(targetScope, projectDir) {
  const { scope } = settings.detectActiveScope(projectDir);
  if (scope === 'both') return targetScope === 'user' ? ['project'] : ['user'];
  if (scope !== 'none' && scope !== targetScope) return [scope];
  return [];
}

function withSetupApiKey(apiKey, fn) {
  const variable = 'CLAUDE_PLUGIN_OPTION_apiKey';
  const hadValue = Object.prototype.hasOwnProperty.call(process.env, variable);
  const previous = process.env[variable];
  process.env[variable] = apiKey;
  try {
    return fn();
  } finally {
    if (hadValue) process.env[variable] = previous;
    else delete process.env[variable];
  }
}

async function applySetup({
  apiKey,
  scope,
  projectDir,
  confirm = false,
  output = console,
  cacheConfigFn = cacheConfig,
  notifyDashboardFn = notifyDashboard,
} = {}) {
  if (!isSupportedApiKey(apiKey)) {
    output.error(APPLY_USAGE);
    return 2;
  }

  const scopeDecision = settings.resolveOtelScope(projectDir);
  if (scope && scopeDecision.targetScope && scopeDecision.targetScope !== scope && !confirm) {
    output.log(`CONFIRM_REQUIRED: ${migrationReason(scopeDecision.targetScope, scope)}`);
    return 3;
  }

  const targetScope = scope || scopeDecision.targetScope || 'user';
  const removeScopes = new Set(scopeDecision.removeScopes);
  if (scope) {
    for (const activeScope of otherActiveScopes(targetScope, projectDir)) {
      removeScopes.add(activeScope);
    }
  }

  writeLocalConfig(apiKey);
  fs.rmSync(config.getCacheFile(), { force: true });

  const cacheExitCode = await cacheConfigFn(apiKey, output);
  if (cacheExitCode !== 0) return cacheExitCode;

  for (const removeScope of removeScopes) {
    if (removeScope !== targetScope) {
      settings.removeOtelSettings({ scope: removeScope, projectDir });
    }
  }

  const synced = withSetupApiKey(apiKey, () => settings.syncOtelSettings({
    scope: targetScope,
    projectDir,
  }));
  if (!synced) {
    output.error('ERROR: unable to sync Prism telemetry settings.');
    return 1;
  }

  await notifyDashboardFn(apiKey, output);

  const resolved = config.getConfig(apiKey);
  output.log('Prism setup complete.');
  output.log(`Scope: ${targetScope}`);
  output.log(`Settings file: ${settings.pathForScope(targetScope, projectDir)}`);
  output.log(`Ingest URL: ${resolved.ingest_url}`);
  output.log('Restart Claude Code to activate telemetry.');
  return 0;
}

async function main(argv = process.argv.slice(2), output = console) {
  const [action, ...args] = argv;
  const apiKey = process.env.PRISM_API_KEY || '';

  if (action === 'cache') return cacheConfig(apiKey, output);
  if (action === 'notify') return notifyDashboard(apiKey, output);
  if (action === 'apply') {
    const parsed = parseApplyArgs(args);
    if (!parsed) {
      output.error(APPLY_USAGE);
      return 2;
    }
    if (parsed.checkExisting) return checkExistingKey(output);
    return applySetup({ apiKey, ...parsed, output });
  }

  output.error(APPLY_USAGE);
  return 2;
}

if (require.main === module) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      console.error(`ERROR: ${error.message || 'unexpected setup failure'}`);
      process.exitCode = 1;
    });
}

module.exports = {
  APPLY_USAGE,
  applySetup,
  cacheConfig,
  checkExistingKey,
  main,
  notifyDashboard,
  parseApplyArgs,
  readLocalConfig,
  writeLocalConfig,
};
