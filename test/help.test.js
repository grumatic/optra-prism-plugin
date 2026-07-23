const assert = require('node:assert/strict');
const test = require('node:test');

const { CONFIG_FIELDS } = require('../lib/config-fields');
const { renderHelp } = require('../lib/help');

test('help lists every configurable field with values and apply behavior', () => {
  const output = renderHelp();

  for (const field of CONFIG_FIELDS) {
    assert.match(output, new RegExp(`^  ${field.name}$`, 'm'));
    assert.ok(output.includes(`values: ${field.allowedValues}`));
    assert.ok(output.includes(`Applies: ${field.applies}`));
  }

  assert.match(output, /\/prism:config set <field> <value>/);
  assert.match(output, /API key[\s\S]*\/prism:setup KEY/);
  assert.doesNotMatch(output, /showRealtimeSummary/);
});
