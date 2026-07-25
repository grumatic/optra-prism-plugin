'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function frontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'markdown must start with frontmatter');
  return match[1];
}

function body(contents) {
  return contents.replace(/^---\n[\s\S]*?\n---\n/, '');
}

test('setup delegates directly to its isolated Haiku agent', () => {
  const commandMetadata = frontmatter(read('commands/setup.md'));
  const agentMetadata = frontmatter(read('agents/prism-setup.md'));

  assert.match(commandMetadata, /^disable-model-invocation: true$/m);
  assert.match(commandMetadata, /^context: fork$/m);
  assert.match(commandMetadata, /^agent: prism:prism-setup$/m);
  assert.doesNotMatch(commandMetadata, /^allowed-tools:/m);

  assert.match(agentMetadata, /^name: prism-setup$/m);
  assert.match(agentMetadata, /^model: haiku$/m);
  assert.match(agentMetadata, /^tools: \["Bash"\]$/m);
  assert.doesNotMatch(agentMetadata, /^allowed-tools:/m);
  assert.equal((agentMetadata.match(/^model:/gm) || []).length, 1);
  assert.equal((agentMetadata.match(/^tools:/gm) || []).length, 1);
});

test('setup maps a key to exactly one apply invocation without inline shell expansion', () => {
  const command = read('commands/setup.md');
  const agent = read('agents/prism-setup.md');
  const commandBody = body(command);
  const invocation = 'node "${CLAUDE_PLUGIN_ROOT}/lib/setup.js" apply "$KEY" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}"';

  assert.equal(commandBody.split(invocation).length - 1, 1);
  assert.equal((commandBody.match(/lib\/setup\.js/g) || []).length, 1);
  assert.equal((commandBody.match(/\bapply\b/g) || []).length, 1);
  assert.deepEqual([...commandBody.matchAll(/!`([^`\n]*)`/g)], []);
  assert.deepEqual([...body(agent).matchAll(/!`([^`\n]*)`/g)], []);
  assert.doesNotMatch(commandBody, /(?:echo|printf)\s+.*\$(?:\{?ARGUMENTS\}?|KEY\b)/i);
  assert.match(agent, /run exactly the one delegated `lib\/setup\.js apply` command/i);
  assert.match(agent, /Do not run a preflight, inspection, validation, retry/i);
});

test('setup relays tool output without leaking the key or adding commentary', () => {
  const command = read('commands/setup.md');
  const agent = read('agents/prism-setup.md');

  for (const contents of [command, agent]) {
    assert.match(contents, /character-for-character/i);
    assert.match(contents, /complete Bash tool-result\s+text/i);
  }

  assert.match(command, /do not\s+validate its prefix, rewrite it, log it, or include it in the final response/i);
  assert.match(agent, /Never print,\s+repeat, transform, validate, or otherwise disclose it/i);
  assert.match(agent, /Do not summarize, explain, label, append guidance/i);
  assert.doesNotMatch(body(command), />\s*🚀|\*\*Next:\*\*/i);
});
