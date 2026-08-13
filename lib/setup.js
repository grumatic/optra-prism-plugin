#!/usr/bin/env node

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const config = require('./config');
const settings = require('./settings');
const { hasApiKey } = require('./api-key');
const { buildBinding } = require('./binding');
const { notifySetupComplete } = require('./notify');
const {
  readCurrentPluginVersion,
  writeActiveVersion,
} = require('./plugin-update');

const APPLY_USAGE = 'Usage: node lib/setup.js apply <KEY> [--project-dir <dir>] [--data-dir <dir>]';

function parseApplyArgs(argv) {
  const args = { projectDir: null, dataDir: null };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    const key = option === '--project-dir'
      ? 'projectDir'
      : option === '--data-dir'
        ? 'dataDir'
        : null;
    if (!key || args[key] !== null || !argv[index + 1]) return null;
    args[key] = argv[++index];
  }
  return args;
}

async function applySetup({
  apiKey,
  projectDir,
  dataDir,
  pluginRoot = path.resolve(__dirname, '..'),
  output = console,
  fetchConfigFn = config.fetchConfig,
  notifyDashboardFn = notifySetupComplete,
  createSetupRunIdFn = randomUUID,
  readCurrentVersionFn = readCurrentPluginVersion,
  writeActiveVersionFn = writeActiveVersion,
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
  const binding = buildBinding({ apiKey, ingestUrl: remote.config.ingest_url });
  if (binding) patch.binding = binding;
  config.patchConfig(patch);

  let installScope;
  let settingsChanged;
  let otelStatus;
  try {
    installScope = settings.detectInstallScope(projectDir, pluginRoot);
    if (!installScope) throw new Error('unknown install scope');

    const beforeEnv = settings.readEffectiveSettings(projectDir).env;
    const beforeHelper = dataDir
      ? settings.readEffectiveSetting(settings.OTEL_HEADERS_HELPER_KEY, projectDir).value
      : null;
    if (!settings.syncOtelSettings({ scope: installScope, projectDir, dataDir })) {
      throw new Error('unable to sync OTEL settings');
    }

    const effective = settings.readEffectiveSettings(projectDir);
    const expected = settings.buildExpectedOtelEnv();
    settingsChanged = Object.keys(expected.otelEnv)
      .some((key) => beforeEnv[key] !== effective.env[key])
      || (dataDir && beforeHelper
        !== settings.readEffectiveSetting(settings.OTEL_HEADERS_HELPER_KEY, projectDir).value);
    otelStatus = settings.checkOtelSettings({ projectDir, dataDir });
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
  if (dataDir) {
    const pluginVersion = readCurrentVersionFn({ pluginRoot });
    if (!pluginVersion || !writeActiveVersionFn(dataDir, pluginVersion)) {
      output.error(
        'Prism config and OTEL settings were saved, but the active plugin version '
        + 'could not be published; run /prism:status for details.',
      );
      return 1;
    }
  }

  let notification;
  try {
    const setupRunId = createSetupRunIdFn();
    notification = await notifyDashboardFn(apiKey, setupRunId);
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
