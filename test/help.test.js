const assert = require('node:assert/strict');
const test = require('node:test');

const { CONFIG_FIELDS, getEditableConfigFields } = require('../lib/config-fields');
const { renderHelp } = require('../lib/help');

test('help lists every configurable field with values and apply behavior', () => {
  const output = renderHelp();

  for (const field of getEditableConfigFields()) {
    assert.match(output, new RegExp(`^  ${field.name}$`, 'm'));
    assert.ok(output.includes(`values: ${field.allowedValues}`));
    assert.ok(output.includes(`Applies: ${field.applies}`));
  }

  for (const field of CONFIG_FIELDS) {
    if (field.editable) continue;
    assert.doesNotMatch(output, new RegExp(`^\\s*${field.name}$`, 'm'));
  }

  assert.match(output, /\/prism:config set <field> <value>/);
  assert.match(output, /API key[\s\S]*\/prism:setup KEY/);
  assert.doesNotMatch(output, /showRealtimeSummary/);
});
