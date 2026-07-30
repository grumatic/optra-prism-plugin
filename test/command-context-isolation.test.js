'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

const COMMAND_AGENTS = Object.freeze({
  config: 'prism-config',
  doctor: 'prism-output',
  help: 'prism-output',
  realtime: 'prism-output',
  report: 'prism-output',
  setup: 'prism-setup',
  status: 'prism-status',
  uninstall: 'prism-uninstall',
});

const AGENT_TOOLS = Object.freeze({
  'prism-config': ['Bash'],
  'prism-output': ['Bash'],
  'prism-setup': ['Bash'],
  'prism-status': ['Bash'],
  'prism-uninstall': ['Bash'],
});

const READ_COMMAND_INVOCATIONS = Object.freeze({
  doctor: 'node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true',
  help: 'node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" 2>&1 || true',
  realtime: 'node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}"',
  report: 'node "${CLAUDE_PLUGIN_ROOT}/lib/report.js" 2>&1 || true',
  status: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true',
});

const MUTATION_COMMANDS = ['config', 'setup', 'uninstall'];
const MUTATION_ENTRYPOINT_PERMISSIONS = Object.freeze({
  config: [
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}")',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" help --project-dir "${CLAUDE_PROJECT_DIR}")',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" set * --project-dir "${CLAUDE_PROJECT_DIR}")',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" unset * --project-dir "${CLAUDE_PROJECT_DIR}")',
  ],
  setup: [
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/setup.js" apply * --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}")',
  ],
  uninstall: [
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/uninstall.js" preview --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plugin-root "${CLAUDE_PLUGIN_ROOT}")',
    'Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/uninstall.js" apply --confirm * --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plugin-root "${CLAUDE_PLUGIN_ROOT}")',
  ],
});

function readMarkdown(directory, name) {
  return fs.readFileSync(path.join(ROOT, directory, `${name}.md`), 'utf8');
}

function frontmatter(contents, subject) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${subject} must start with frontmatter`);
  return match[1];
}

function body(contents) {
  return contents.replace(/^---\n[\s\S]*?\n---\n/, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scalar(metadata, key, subject) {
  const matches = [
    ...metadata.matchAll(new RegExp(`^${escapeRegExp(key)}:\\s*(\\S.*)$`, 'gm')),
  ];
  assert.equal(matches.length, 1, `${subject} must declare ${key} exactly once`);
  return matches[0][1].trim();
}

function doesNotDeclare(metadata, key, subject) {
  assert.doesNotMatch(
    metadata,
    new RegExp(`^${escapeRegExp(key)}:`, 'm'),
    `${subject} must not declare ${key}`,
  );
}

function list(metadata, key, subject) {
  const lines = metadata.split('\n');
  const fieldPattern = new RegExp(`^${escapeRegExp(key)}:(.*)$`);
  const fields = lines
    .map((line, index) => ({ index, match: line.match(fieldPattern) }))
    .filter(({ match }) => match);

  assert.ok(fields.length <= 1, `${subject} must not declare ${key} more than once`);
  if (fields.length === 0) return [];

  const [{ index, match }] = fields;
  const inlineValue = match[1].trim();
  if (inlineValue) {
    assert.match(inlineValue, /^\[.*\]$/, `${subject} ${key} must be a YAML list`);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(inlineValue);
    }, `${subject} ${key} inline list must be valid JSON`);
    assert.ok(Array.isArray(parsed), `${subject} ${key} must be an array`);
    return parsed;
  }

  const values = [];
  for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === '') continue;
    if (!/^\s/.test(line)) break;

    const item = line.match(/^  - (.+)$/);
    assert.ok(item, `${subject} ${key} entries must use two-space YAML list indentation`);
    values.push(item[1].trim());
  }
  return values;
}

function inlineShellInvocations(contents) {
  return [...body(contents).matchAll(/!`([^`\n]*)`/g)].map((match) => match[1]);
}

function assertNoBroadBashPermission(value, subject) {
  assert.doesNotMatch(value, /Bash\(\s*node\s*:\s*\*\s*\)/i, subject);
  assert.doesNotMatch(value, /Bash\(\s*node\s+\*\s*\)/i, subject);
  assert.doesNotMatch(value, /Bash\(\s*\*\s*\)/i, subject);
}

test('all user-invocable commands declare a main-context controller boundary', () => {
  const discoveredCommands = fs.readdirSync(path.join(ROOT, 'commands'))
    .filter((entry) => entry.endsWith('.md'))
    .filter((entry) => {
      const contents = fs.readFileSync(path.join(ROOT, 'commands', entry), 'utf8');
      return /^user-invocable:\s*true$/m.test(frontmatter(contents, `commands/${entry}`));
    })
    .map((entry) => path.basename(entry, '.md'))
    .sort();

  assert.deepEqual(
    discoveredCommands,
    Object.keys(COMMAND_AGENTS).sort(),
    'the global isolation contract must enumerate every user-invocable command',
  );

  for (const [commandName, agentName] of Object.entries(COMMAND_AGENTS)) {
    const subject = `commands/${commandName}.md`;
    const metadata = frontmatter(readMarkdown('commands', commandName), subject);

    assert.equal(scalar(metadata, 'name', subject), `prism:${commandName}`);
    assert.equal(scalar(metadata, 'user-invocable', subject), 'true');
    assert.equal(scalar(metadata, 'disable-model-invocation', subject), 'true');
    assert.equal(scalar(metadata, 'model', subject), 'haiku');
    doesNotDeclare(metadata, 'context', subject);
    doesNotDeclare(metadata, 'background', subject);
    doesNotDeclare(metadata, 'agent', subject);

    const expectedTools = [
      `Agent(prism:${agentName})`,
      ...(READ_COMMAND_INVOCATIONS[commandName]
        ? [`Bash(${READ_COMMAND_INVOCATIONS[commandName]})`]
        : MUTATION_ENTRYPOINT_PERMISSIONS[commandName]),
    ];
    assert.deepEqual(list(metadata, 'allowed-tools', subject), expectedTools);
  }
});

test('every referenced agent is a bounded foreground Haiku executor', () => {
  for (const agentName of new Set(Object.values(COMMAND_AGENTS))) {
    const subject = `agents/${agentName}.md`;
    const agentPath = path.join(ROOT, 'agents', `${agentName}.md`);

    assert.equal(fs.existsSync(agentPath), true, `${subject} must be packaged`);
    const metadata = frontmatter(fs.readFileSync(agentPath, 'utf8'), subject);

    assert.equal(scalar(metadata, 'name', subject), agentName);
    assert.equal(scalar(metadata, 'model', subject), 'haiku');
    assert.deepEqual(list(metadata, 'tools', subject), AGENT_TOOLS[agentName]);
    assert.equal(scalar(metadata, 'background', subject), 'false');
    assert.equal(scalar(metadata, 'maxTurns', subject), '2');
    doesNotDeclare(metadata, 'allowed-tools', subject);
  }
});

test('no command restores a wildcard Node Bash permission', () => {
  for (const commandName of Object.keys(COMMAND_AGENTS)) {
    const subject = `commands/${commandName}.md`;
    const metadata = frontmatter(readMarkdown('commands', commandName), subject);

    assertNoBroadBashPermission(metadata, `${subject} must not allow Bash(node:*)`);
  }
});

test('read controllers delegate and pre-authorize only their one fixed entrypoint', () => {
  for (const [commandName, invocation] of Object.entries(READ_COMMAND_INVOCATIONS)) {
    const subject = `commands/${commandName}.md`;
    const contents = readMarkdown('commands', commandName);
    const metadata = frontmatter(contents, subject);
    const commandBody = body(contents);

    assert.deepEqual(inlineShellInvocations(contents), []);
    assert.equal(
      commandBody.split(invocation).length - 1,
      1,
      `${subject} must delegate its fixed entrypoint exactly once`,
    );
    if (commandName === 'realtime') {
      assert.doesNotMatch(
        invocation,
        /2>&1|\|\|/,
        `${subject} normalizes failures inside its deterministic entrypoint`,
      );
    } else {
      assert.match(
        invocation,
        / 2>&1 \|\| true$/,
        `${subject} must merge stderr and normalize the script failure status`,
      );
      assert.equal(
        (invocation.match(/2>&1/g) || []).length,
        1,
        `${subject} must declare the stderr redirect exactly once`,
      );
      assert.equal(
        (invocation.match(/\|\| true/g) || []).length,
        1,
        `${subject} must normalize the read command exit status exactly once`,
      );
    }
    assert.deepEqual(
      list(metadata, 'allowed-tools', subject),
      [
        `Agent(prism:${COMMAND_AGENTS[commandName]})`,
        `Bash(${invocation})`,
      ],
      `${subject} must pre-authorize only its fixed entrypoint and argument shape`,
    );
    assert.match(
      commandBody,
      new RegExp(`Use the \`prism:${COMMAND_AGENTS[commandName]}\` Agent exactly once`, 'i'),
    );
    assert.match(commandBody, /Do not call Bash or any other tool yourself/i);
    assert.match(commandBody, /final response exactly the first text content block/i);
    assert.match(commandBody, /Ignore\s+the continuation `agentId` and usage metadata/i);
  }
});

test('commands no longer use inline shell expansion', () => {
  for (const commandName of Object.keys(COMMAND_AGENTS)) {
    assert.deepEqual(inlineShellInvocations(readMarkdown('commands', commandName)), []);
  }
});

test('mutating commands pre-authorize only validated plugin entrypoint shapes', () => {
  const dynamicArgumentPattern = /\$(?:\{?(?:ARGUMENTS|FIELD|KEY|VALUE)\}?|\{?[0-9]+\}?|[@*])/i;

  for (const commandName of MUTATION_COMMANDS) {
    const subject = `commands/${commandName}.md`;
    const metadata = frontmatter(readMarkdown('commands', commandName), subject);

    const permissions = list(metadata, 'allowed-tools', subject)
      .filter((permission) => permission.startsWith('Bash('));
    assert.deepEqual(permissions, MUTATION_ENTRYPOINT_PERMISSIONS[commandName]);

    for (const permission of permissions) {
      assertNoBroadBashPermission(permission, `${subject} permission must stay entrypoint-scoped`);
      assert.doesNotMatch(
        permission,
        /(?:&&|\|\||[;|&]\s|[\r\n])/,
        `${subject} permission must not include a compound command`,
      );
      assert.ok(
        MUTATION_ENTRYPOINT_PERMISSIONS[commandName].includes(permission),
        `${subject} may pre-authorize only its deterministic plugin entrypoint shapes`,
      );
      assert.doesNotMatch(
        permission,
        dynamicArgumentPattern,
        `${subject} must not pre-authorize user-controlled arguments`,
      );
    }
  }
});
