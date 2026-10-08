#!/usr/bin/env node

const path = require('path');
const { assertPluginContext } = require('./claude-paths');
const config = require('./config');
const { getConfigField, getEditableConfigFields } = require('./config-fields');
const settings = require('./settings');
const hostTelemetry = require('./host-telemetry');

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

const TRAILING_OPTIONS = { '--project-dir': 'projectDir', '--data-dir': 'dataDir' };

function parseArgs(argv) {
  const args = [...argv];
  const options = { projectDir: undefined, dataDir: undefined };

  // Options are a trailing block of `--project-dir <dir>` and `--data-dir <dir>`
  // pairs; anything else positioned after the action is rejected below.
  while (args.length >= 2 && Object.hasOwn(TRAILING_OPTIONS, args[args.length - 2])) {
    const key = TRAILING_OPTIONS[args[args.length - 2]];
    if (options[key] !== undefined || !args[args.length - 1]) break;
    options[key] = args[args.length - 1];
    args.splice(args.length - 2, 2);
  }
  for (const flag of Object.keys(TRAILING_OPTIONS)) {
    const index = args.indexOf(flag);
    if (index !== -1) {
      throw usageError(`${flag} must be a final option and include a directory.`);
    }
  }
  const { projectDir, dataDir } = options;

  const action = args[0] || 'show';
  if (action === 'show' && args.length <= 1) return { action, projectDir, dataDir };
  if ((action === 'help' || action === '--help') && args.length === 1) {
    return { action: action === '--help' ? 'help' : action, projectDir, dataDir };
  }
  if (action === 'set' && args.length === 3) {
    return { action, key: args[1], value: args[2], projectDir, dataDir };
  }
  if (action === 'unset' && args.length === 2) {
    return { action, key: args[1], projectDir, dataDir };
  }
  throw usageError(
    'Usage: show | help | set <field> <value> | unset <field> ' +
      '[--project-dir <dir>] [--data-dir <dir>]',
  );
}

function availableFields() {
  return getEditableConfigFields().map((field) => `  ${field.name}`).join('\n');
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

  for (const field of getEditableConfigFields()) {
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

  for (const field of getEditableConfigFields()) {
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

function main(
  argv = process.argv.slice(2),
  output = console,
  { pluginRoot = path.resolve(__dirname, '..') } = {},
) {
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

    // The install context and, for an ingest_url change that must reproject
    // OTEL settings, the install scope are verified before the first write.
    assertPluginContext({ pluginRoot, dataDir: args.dataDir });
    let installScope = null;
    if (field.name === 'ingest_url' && (args.action === 'unset' || hasApiKey)) {
      installScope = settings.detectInstallScope(args.projectDir, pluginRoot);
      if (!installScope) {
        output.error(
          '[prism:config] ingest_url was not changed because the Prism install scope is ' +
            'unknown. Inspect /prism:status.',
        );
        return 1;
      }
    }

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
          const scope = installScope;
          settings.removeOtelSettings({ scope, projectDir: args.projectDir });
          const { projectTelemetryIgnored } = settings.resolveTelemetryScope({
            scope,
            projectDir: args.projectDir,
          });
          const effective = settings.readEffectiveSettings(args.projectDir, { projectTelemetryIgnored });
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
          const scope = installScope;
          if (!settings.syncOtelSettings({ scope, projectDir: args.projectDir, pluginRoot })) {
            output.error(
              '[prism:config] ingest_url was saved, but OTEL settings could not be projected. ' +
                'Run /prism:setup KEY, then rerun this command.',
            );
            return 1;
          }
          const otelStatus = settings.checkOtelSettings({
            projectDir: args.projectDir,
            pluginRoot,
          });
          if (otelStatus.telemetryWithheld) {
            printChange(args.action, field, effectiveValue, output);
            output.log(hostTelemetry.withheldTelemetrySummary({
              scope: otelStatus.installScope,
              hostVersion: otelStatus.hostVersion,
            }));
            output.log(hostTelemetry.withheldTelemetryRemediation({ scope: otelStatus.installScope }));
            return 0;
          }
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
