#!/usr/bin/env node

const config = require('./config');
const settings = require('./settings');
const { hasApiKey } = require('./api-key');
const { notifySetupComplete } = require('./notify');

const APPLY_USAGE = 'Usage: node lib/setup.js apply <KEY> [--project-dir <dir>]';

function parseApplyArgs(argv) {
  const args = { projectDir: null };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== '--project-dir'
      || args.projectDir !== null
      || !argv[index + 1]) return null;
    args.projectDir = argv[++index];
  }
  return args;
}

async function applySetup({
  apiKey,
  projectDir,
  output = console,
  fetchConfigFn = config.fetchConfig,
  notifyDashboardFn = notifySetupComplete,
} = {}) {
  if (!hasApiKey(apiKey)) {
    output.error(APPLY_USAGE);
    return 2;
  }

  const remote = await fetchConfigFn(apiKey);
  if (remote.status === 'auth-error') {
    output.error(`ERROR: config endpoint rejected the API key (HTTP ${remote.authStatus}).`);
    return 2;
  }
  if (remote.status !== 'server') {
    output.error(`ERROR: ${remote.message || 'unable to fetch Prism configuration.'}`);
    return 1;
  }

  const patch = { ...remote.config, apiKey };
  config.patchConfig(patch);

  let installScope;
  let settingsChanged;
  let otelStatus;
  try {
    installScope = settings.detectInstallScope(projectDir);
    if (!installScope) throw new Error('unknown install scope');

    const beforeEnv = settings.readEffectiveSettings(projectDir).env;
    if (!settings.syncOtelSettings({ scope: installScope, projectDir })) {
      throw new Error('unable to sync OTEL settings');
    }

    const effective = settings.readEffectiveSettings(projectDir);
    const expected = settings.buildExpectedOtelEnv();
    settingsChanged = Object.keys(expected.otelEnv)
      .some((key) => beforeEnv[key] !== effective.env[key]);
    otelStatus = settings.checkOtelSettings({ projectDir });
  } catch (error) {
    output.error(
      `Prism config saved, but OTEL projection failed: ${error.message}. ` +
        'Run /prism:status for the effective settings.',
    );
    return 1;
  }

  if (!otelStatus.ok) {
    output.error('Prism config saved, but effective OTEL settings are overridden; run /prism:status for details.');
    return 1;
  }

  let notification;
  try {
    notification = await notifyDashboardFn(apiKey);
  } catch (error) {
    notification = { ok: false, httpStatus: null, error: error.message };
  }

  output.log('Prism setup complete.');
  output.log(`Scope: ${installScope}`);
  output.log(`Settings file: ${settings.pathForScope(installScope, projectDir)}`);
  output.log(`Ingest URL: ${config.getConfig().ingest_url}`);
  if (settingsChanged) output.log('Restart Claude Code to activate telemetry.');
  if (!notification || notification.ok !== true) {
    const detail = notification && (notification.error
      || (notification.httpStatus ? `HTTP ${notification.httpStatus}` : null));
    output.error(
      `Local setup succeeded, but the dashboard setup notification failed${detail ? `: ${detail}` : ''}.`,
    );
  }
  return 0;
}

async function main(argv = process.argv.slice(2), output = console) {
  const [action, apiKey, ...args] = argv;
  if (action !== 'apply' || !hasApiKey(apiKey)) {
    output.error(APPLY_USAGE);
    return 2;
  }

  const parsed = parseApplyArgs(args);
  if (!parsed) {
    output.error(APPLY_USAGE);
    return 2;
  }
  return applySetup({ apiKey, ...parsed, output });
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
  main,
  parseApplyArgs,
};
