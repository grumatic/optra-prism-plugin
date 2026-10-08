require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PLACEHOLDER = '${CLAUDE_PLUGIN_ROOT}';
// A plugin root under a CLAUDE_CONFIG_DIR such as ".../Application Support/claude".
const SPACED_ROOT = '/tmp/Application Support/claude/plugins/cache/optra-prism/prism/0.0.0';

function hookCommands() {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const commands = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.type === 'command') commands.push({ event, command: hook.command });
      }
    }
  }
  return commands;
}

// Words the shell produces for `command`, without running the interpreter.
function shellWords(command, env = {}) {
  const output = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  return output.split('\n').slice(0, -1);
}

test('every hook command quotes the plugin root placeholder', () => {
  const commands = hookCommands();
  assert.equal(commands.length, 7);
  for (const { event, command } of commands) {
    assert.match(command, /^(?:bash|node) "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/[^"\s]+"$/, event);
  }
});

test('a plugin root containing spaces stays one argument after literal substitution', () => {
  for (const { event, command } of hookCommands()) {
    const words = shellWords(command.split(PLACEHOLDER).join(SPACED_ROOT));
    assert.equal(words.length, 2, event);
    assert.ok(words[1].startsWith(`${SPACED_ROOT}/hooks/scripts/`), event);
  }
});

test('a plugin root containing spaces stays one argument after shell expansion', () => {
  for (const { event, command } of hookCommands()) {
    const words = shellWords(command, { CLAUDE_PLUGIN_ROOT: SPACED_ROOT });
    assert.equal(words.length, 2, event);
    assert.ok(words[1].startsWith(`${SPACED_ROOT}/hooks/scripts/`), event);
  }
});
