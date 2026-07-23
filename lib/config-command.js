#!/usr/bin/env node

const config = require('./config');
const { CONFIG_FIELDS, getConfigField } = require('./config-fields');
const settings = require('./settings');

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArgs(argv) {
  const args = [...argv];
  let projectDir;
  const projectDirIndex = args.indexOf('--project-dir');

  if (projectDirIndex !== -1) {
    if (projectDirIndex !== args.length - 2 || !args[projectDirIndex + 1]) {
      throw usageError('--project-dir must be the final option and include a directory.');
    }
    projectDir = args[projectDirIndex + 1];
    args.splice(projectDirIndex, 2);
  }

  const action = args[0] || 'show';
  if (action === 'show' && args.length <= 1) return { action, projectDir };
  if ((action === 'help' || action === '--help') && args.length === 1) {
    return { action: action === '--help' ? 'help' : action, projectDir };
  }
  if (action === 'set' && args.length === 3) {
    return { action, key: args[1], value: args[2], projectDir };
  }
  if (action === 'unset' && args.length === 2) {
    return { action, key: args[1], projectDir };
  }
  throw usageError(
    'Usage: show | help | set <field> <value> | unset <field> [--project-dir <dir>]',
  );
}

function availableFields() {
  return CONFIG_FIELDS.map((field) => `  ${field.name}`).join('\n');
}

function resolveField(key) {
  if (key === 'apiKey' || key === 'api_key') {
    throw usageError('The API key is managed separately. Run /prism:setup KEY.');
  }

  const field = getConfigField(key);
  if (!field) {
    throw usageError(
      `Unsupported config field: ${key}\n\nAvailable fields:\n${availableFields()}\n\n` +
        'Run /prism:config help for details.',
    );
  }
  return field;
}

function parseIngestUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw usageError(
      'ingest_url must use HTTPS, or HTTP on loopback, without credentials, query, or fragment.',
    );
  }
  const raw = value.trim();
  if (!config.isSupportedIngestUrl(raw)) {
    throw usageError(
      'ingest_url must use HTTPS, or HTTP on loopback, without credentials, query, or fragment.',
    );
  }
  return raw;
}

function parseValue(field, value) {
  if (field.type === 'boolean') {
    if (value !== 'true' && value !== 'false') {
      throw usageError(`${field.name} must be exactly true or false.`);
    }
    return value === 'true';
  }

  return parseIngestUrl(value);
}

function formatValue(value) {
  return value === null || value === undefined ? 'not set' : JSON.stringify(value);
}

function show(output) {
  const effective = config.getConfig();
  const lines = ['Prism Runtime Configuration', ''];

  for (const field of CONFIG_FIELDS) {
    lines.push(
      field.name,
      `  Current: ${formatValue(effective[field.name])}`,
      `  Type: ${field.type}`,
      `  Values: ${field.allowedValues}`,
      `  Applies: ${field.applies}`,
      `  Description: ${field.description}`,
      '',
    );
  }

  lines.push(
    'Commands:',
    '  /prism:config set <field> <value>',
    '  /prism:config unset <field>',
    '  /prism:config help',
    '',
    'API key:',
    '  /prism:setup KEY',
  );
  output.log(lines.join('\n'));
}

function help(output) {
  const lines = [
    'Prism Configuration',
    '',
    'Usage:',
    '  /prism:config',
    '  /prism:config show',
    '  /prism:config help',
    '  /prism:config set <field> <value>',
    '  /prism:config unset <field>',
    '',
    'Configurable fields:',
  ];

  for (const field of CONFIG_FIELDS) {
    lines.push(
      `  ${field.name}`,
      `    Type: ${field.type}`,
      `    Values: ${field.allowedValues}`,
      `    Default: ${formatValue(field.defaultValue)}`,
      `    Applies: ${field.applies}`,
      `    ${field.description}`,
    );
  }

  lines.push('', 'API key is managed separately with /prism:setup KEY.');
  output.log(lines.join('\n'));
}

function printChange(action, field, effectiveValue, output) {
  const value = formatValue(effectiveValue);
  output.log(action === 'set'
    ? `Set ${field.name} to ${value}.`
    : `Unset ${field.name}; effective value is ${value}.`);
}

function main(argv = process.argv.slice(2), output = console) {
  try {
    const args = parseArgs(argv);
    if (args.action === 'show') {
      show(output);
      return 0;
    }
    if (args.action === 'help') {
      help(output);
      return 0;
    }

    const field = resolveField(args.key);
    const value = args.action === 'set' ? parseValue(field, args.value) : undefined;
    const current = config.getConfig();
    const hasApiKey = field.name === 'ingest_url'
      && typeof current.apiKey === 'string'
      && current.apiKey.length > 0;

    if (args.action === 'set') {
      config.patchConfig({ [field.name]: value });
    } else {
      config.removeConfigField(field.name, field.legacyNames);
    }

    const effectiveValue = config.getConfig()[field.name];
    let nextStep = 'This change applies on the next Hook invocation.';
    if (field.name === 'ingest_url') {
      if (args.action === 'unset') {
        try {
          const scope = settings.detectInstallScope(args.projectDir);
          if (!scope) {
            output.error(
              '[prism:config] ingest_url was unset, but OTEL settings were not removed because ' +
                'the Prism install scope is unknown. Inspect /prism:status.',
            );
            return 1;
          }

          settings.removeOtelSettings({ scope, projectDir: args.projectDir });
          const effective = settings.readEffectiveSettings(args.projectDir);
          const remaining = settings.OTEL_KEYS.filter((key) =>
            Object.prototype.hasOwnProperty.call(effective.env, key));
          if (remaining.length > 0) {
            output.error(
              '[prism:config] ingest_url was unset and installed-scope OTEL settings were removed, ' +
                `but effective OTEL values remain in another settings layer: ${remaining.join(', ')}. ` +
                'Inspect /prism:status, then restart Claude Code.',
            );
            return 1;
          }
          nextStep =
            `OTEL settings were removed from the ${scope} install scope. ` +
            'Restart Claude Code for this change to take effect.';
        } catch (error) {
          output.error(`[prism:config] ingest_url was unset, but OTEL removal failed: ${error.message}`);
          return 1;
        }
      } else if (!hasApiKey) {
        nextStep = 'Run /prism:setup KEY to complete telemetry configuration.';
      } else {
        try {
          const scope = settings.detectInstallScope(args.projectDir);
          if (!scope) {
            output.error(
              '[prism:config] Config saved, but OTEL projection was not updated because the ' +
                'Prism install scope is unknown. Run /prism:setup KEY, then retry.',
            );
            return 1;
          }
          if (!settings.syncOtelSettings({ scope, projectDir: args.projectDir })) {
            output.error(
              '[prism:config] ingest_url was saved, but OTEL settings could not be projected. ' +
                'Run /prism:setup KEY, then rerun this command.',
            );
            return 1;
          }
          const otelStatus = settings.checkOtelSettings({ projectDir: args.projectDir });
          if (!otelStatus.ok) {
            output.error(
              '[prism:config] Config saved, but effective OTEL settings are out of sync: ' +
                `${otelStatus.mismatches.join(', ')}. Inspect /prism:status, align the ` +
                'higher-precedence layer, then restart Claude Code.',
            );
            return 1;
          }
          nextStep =
            `OTEL settings were reprojected to the ${scope} install scope. ` +
            'Restart Claude Code for this change to take effect.';
        } catch (error) {
          output.error(`[prism:config] Config saved, but OTEL projection failed: ${error.message}`);
          return 1;
        }
      }
    }

    printChange(args.action, field, effectiveValue, output);
    output.log(nextStep);
    return 0;
  } catch (error) {
    output.error(`[prism:config] ${error.message}`);
    return error.exitCode || 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
