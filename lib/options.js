const fs = require('fs');
const os = require('os');
const path = require('path');

function readLegacyConfig() {
  try {
    const configPath = path.join(os.homedir(), '.prism', 'config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function invalidResult(source, defaultValue) {
  return {
    value: defaultValue,
    source,
    error: `Invalid boolean value from ${source}; using the safe default.`,
  };
}

function resolveBooleanOption({
  officialEnv,
  compatEnv,
  legacyKey,
  defaultValue,
  env = process.env,
  legacyConfig = readLegacyConfig(),
}) {
  const sources = [
    ['env-official', officialEnv],
    ['env-compat', compatEnv],
  ];

  for (const [source, envKey] of sources) {
    if (!Object.prototype.hasOwnProperty.call(env, envKey)) continue;

    const value = parseBoolean(env[envKey]);
    return value === null
      ? invalidResult(source, defaultValue)
      : { value, source };
  }

  if (Object.prototype.hasOwnProperty.call(legacyConfig, legacyKey)) {
    const value = parseBoolean(legacyConfig[legacyKey]);
    return value === null
      ? invalidResult('legacy', defaultValue)
      : { value, source: 'legacy' };
  }

  return { value: defaultValue, source: 'default' };
}

function resolveShowRealtimeSummary() {
  return resolveBooleanOption({
    officialEnv: 'CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY',
    compatEnv: 'CLAUDE_PLUGIN_OPTION_showRealtimeSummary',
    legacyKey: 'showRealtimeSummary',
    defaultValue: true,
  });
}

module.exports = {
  resolveBooleanOption,
  resolveShowRealtimeSummary,
};
