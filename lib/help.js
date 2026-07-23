#!/usr/bin/env node

const { CONFIG_FIELDS } = require('./config-fields');

function renderHelp() {
  const lines = [
    'Prism Plugin Commands',
    '',
    'Setup & Config',
    '  /prism:setup KEY                     Register Prism API key and enable telemetry',
    '  /prism:config                        List configurable fields and current values',
    '  /prism:config show                   Show configurable fields and current values',
    '  /prism:config help                   Show field types, values, and apply behavior',
    '  /prism:config set <field> <value>    Set a runtime configuration value',
    '  /prism:config unset <field>          Remove a runtime configuration value',
    '  /prism:status                        Read-only config, connection, and session status',
    '  /prism:doctor                        Diagnose local config, OTEL projection, and ingest health',
    '  /prism:help                          Show this command list',
    '  /prism:uninstall                     Remove plugin, clear all settings',
    '',
    'Configurable fields',
  ];

  for (const field of CONFIG_FIELDS) {
    lines.push(
      `  ${field.name}`,
      `      Type: ${field.type}; values: ${field.allowedValues}`,
      `      ${field.description}`,
      `      Applies: ${field.applies}`,
    );
  }

  lines.push(
    '',
    '  API key',
    '      Managed separately with /prism:setup KEY',
    '',
    'Review',
    '  /prism:realtime           Current server-side PRISM grade on demand — cost and turns',
    '  /prism:report             Weekly review — this week vs last week, PRISM grade, habits, worst prompts',
    '',
    'Automatic (hooks — no command needed)',
    '  Prompt/response capture   Uses exact host prompt_id correlation; unmatched turns are skipped',
    '  Realtime score summary    Shows the server-side PRISM grade, cost, and turn count when enabled',
    '  Realtime score (VS Code)  Panel does not render hook messages; use /prism:realtime',
    '  Terminal status line      Not supported',
    '',
    'Getting started:',
    '  1. /prism:setup YOUR_KEY  Set up your Prism API key',
    '  2. Start coding           Telemetry activates automatically',
    '  3. /prism:report          Compare this week vs last week',
    '',
    'Dashboard:         https://dashboard.optra-prism.com/',
    'Get your API key:  https://dashboard.optra-prism.com/setup',
    'Documentation:     https://optra-prism.com/docs',
  );

  return lines.join('\n');
}

function main(output = console) {
  output.log(renderHelp());
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, renderHelp };
