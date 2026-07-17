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
function invalidStringResult(source, defaultValue) {
  return {
    value: defaultValue,
    source,
    error: `Invalid string value from ${source}; using the safe default.`,
  };
}

function resolveStringOption({
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

    const value = env[envKey];
    return typeof value !== 'string' || value.length === 0
      ? invalidStringResult(source, defaultValue)
      : { value, source };
  }

  if (Object.prototype.hasOwnProperty.call(legacyConfig, legacyKey)) {
    const value = legacyConfig[legacyKey];
    return (typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0
      ? invalidStringResult('legacy', defaultValue)
      : { value: String(value), source: 'legacy' };
  }

  return { value: defaultValue, source: 'default' };
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
    // Opt-in by design: the Stop-hook realtime score line stays silent until
    // the user enables it explicitly (env option or legacy config).
    defaultValue: false,
  });
}

module.exports = {
  resolveBooleanOption,
  resolveStringOption,
  resolveShowRealtimeSummary,
};
