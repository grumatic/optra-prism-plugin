// Architecture guard: command markdown stays a thin relay around one
// deterministic CLI entrypoint. Scripts compute AND render; the model only
// displays output verbatim. Prose renderers must not grow back.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { renderHelp } = require('../lib/help');

const ROOT = path.join(__dirname, '..');
const READ_COMMANDS = Object.freeze({
  doctor: 'node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true',
  help: 'node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" 2>&1 || true',
  realtime: 'node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}"',
  report: 'node "${CLAUDE_PLUGIN_ROOT}/lib/report.js" 2>&1 || true',
  status: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true',
});

function readCommand(name) {
  return fs.readFileSync(path.join(ROOT, 'commands', `${name}.md`), 'utf8');
}

function readAgent(name) {
  return fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8');
}

function frontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'command markdown must start with frontmatter');
  return match[1];
}

function body(contents) {
  return contents.replace(/^---\n[\s\S]*?\n---\n/, '');
}

function nodeInvocations(contents) {
  // Entrypoints resolve the plugin root via the official ${CLAUDE_PLUGIN_ROOT}
  // substitution (not the bogus $PLUGIN_DIR, which never resolves).
  return (body(contents).match(/node "\$\{CLAUDE_PLUGIN_ROOT\}/g) || []).length;
}

function inlineShellInvocations(contents) {
  return [...body(contents).matchAll(/!`([^`\n]*)`/g)].map((match) => match[1]);
}

test('commands reference only Claude Code substitution variables, never bogus ones', () => {
  for (const name of ['realtime', 'status', 'doctor', 'report', 'setup', 'config']) {
    const contents = body(readCommand(name));
    assert.doesNotMatch(contents, /\$PLUGIN_DIR|\$\{PLUGIN_DIR\}/, `${name}.md must not use $PLUGIN_DIR`);
    assert.doesNotMatch(contents, /CLAUDE_CODE_SESSION_ID/, `${name}.md must not use $CLAUDE_CODE_SESSION_ID`);
  }
});

test('read controllers pre-authorize and delegate only their exact entrypoints', () => {
  for (const [name, invocation] of Object.entries(READ_COMMANDS)) {
    const contents = readCommand(name);
    const metadata = frontmatter(contents);

    assert.deepEqual(inlineShellInvocations(contents), []);
    assert.equal(body(contents).split(invocation).length - 1, 1);
    if (name === 'realtime') {
      assert.doesNotMatch(
        invocation,
        /2>&1|\|\|/,
        `${name}.md normalizes failures inside its deterministic entrypoint`,
      );
    } else {
      assert.match(
        invocation,
        / 2>&1 \|\| true$/,
        `${name}.md must relay stderr and normalize only the read command exit`,
      );
    }
    assert.ok(
      metadata.includes(`- Bash(${invocation})`),
      `${name}.md must pre-authorize only its exact delegated entrypoint`,
    );
    assert.match(metadata, /^  - Agent\(prism:prism-(?:output|status)\)$/m);
    assert.doesNotMatch(metadata, /\*/, `${name}.md must not pre-authorize a wildcard`);
    assert.doesNotMatch(metadata, /Bash\(node:\*\)/, `${name}.md must not allow arbitrary Node commands`);
    assert.match(contents, /final response exactly the first text content block/i);
  }
});

test('setup pre-authorizes only its validated apply entrypoint shape', () => {
  const metadata = frontmatter(readCommand('setup'));
  assert.match(metadata, /^allowed-tools:$/m);
  assert.match(metadata, /^  - Agent\(prism:prism-setup\)$/m);
  assert.match(
    metadata,
    /^  - Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/setup\.js" apply \* --project-dir "\$\{CLAUDE_PROJECT_DIR\}" --data-dir "\$\{CLAUDE_PLUGIN_DATA\}"\)$/m,
  );
  assert.equal((metadata.match(/^  - Bash\(/gm) || []).length, 1);
});

test('config pre-authorizes only its four validated action shapes', () => {
  const metadata = frontmatter(readCommand('config'));
  const permissions = metadata.split('\n').filter((line) => line.trimStart().startsWith('- Bash('));

  assert.equal(permissions.length, 4);
  assert.match(permissions[0], /config-command\.js" show --project-dir/);
  assert.match(permissions[1], /config-command\.js" help --project-dir/);
  assert.match(permissions[2], /config-command\.js" set \* --project-dir/);
  assert.match(permissions[3], /config-command\.js" unset \* --project-dir/);
  assert.doesNotMatch(permissions.join('\n'), /Bash\(node:\*\)|Bash\(node \*\)/);
});

test('deterministic commands are a single entrypoint call plus verbatim display', () => {
  for (const name of ['doctor', 'report', 'help']) {
    const contents = readCommand(name);
    assert.equal(nodeInvocations(contents), 1, `${name}.md must call exactly one entrypoint`);
    assert.match(contents, /verbatim/i, `${name}.md must display output verbatim`);
    assert.ok(
      body(contents).split('\n').length <= 25,
      `${name}.md body must stay under the line budget`,
    );
  }
});

test('status stays a single read-only entrypoint', () => {
  const contents = readCommand('status');
  const metadata = frontmatter(contents);
  assert.equal(nodeInvocations(contents), 1);
  assert.equal(inlineShellInvocations(contents).length, 0);
  assert.match(metadata, /^model: haiku$/m);
  assert.match(metadata, /^  - Agent\(prism:prism-status\)$/m);
  assert.doesNotMatch(metadata, /^(?:context|background|agent):/m);
  assert.match(contents, /verbatim/i);
  assert.match(contents, /final response exactly the first text content block/i);
  assert.match(contents, /Ignore\s+the continuation `agentId` and usage metadata/i);
});

test('config is a thin relay to the deterministic config entrypoint', () => {
  const contents = readCommand('config');
  assert.match(contents, /lib\/config-command\.js/);
  assert.match(contents, /\bshow\b/);
  assert.match(contents, /\bset\b/);
  assert.match(contents, /\bunset\b/);
  assert.match(contents, /final response exactly the first text content block/i);
  assert.match(readAgent('prism-config'), /character-for-character/i);
  assert.doesNotMatch(contents, /PRISM_(?:API_KEY|INGEST_URL)|CLAUDE_PLUGIN_OPTION/);
});

test('config uses a main-context controller and a dedicated executor', () => {
  const commandMetadata = frontmatter(readCommand('config'));
  const agentContents = readAgent('prism-config');
  const agentMetadata = frontmatter(agentContents);

  assert.match(commandMetadata, /^model: haiku$/m);
  assert.match(commandMetadata, /^  - Agent\(prism:prism-config\)$/m);
  assert.doesNotMatch(commandMetadata, /^(?:context|background|agent):/m);
  assert.match(commandMetadata, /^disable-model-invocation: true$/m);
  assert.match(agentMetadata, /^model: haiku$/m);
  assert.match(agentMetadata, /^tools: \["Bash"\]$/m);
  assert.match(agentMetadata, /^background: false$/m);
  assert.match(agentMetadata, /^maxTurns: 2$/m);
  assert.equal((agentMetadata.match(/^model:/gm) || []).length, 1);
  assert.equal((agentMetadata.match(/^tools:/gm) || []).length, 1);
  assert.match(agentContents, /character-for-character/i);
  assert.match(agentContents, /Do\s+not summarize/i);
  assert.match(readCommand('config'), /final response exactly the first text content block/i);
});

test('config never interpolates user arguments into inline shell commands', () => {
  const sources = [readCommand('config'), readAgent('prism-config')];
  const userArgument = /\$(?:\{?ARGUMENTS\}?|\{?\d+\}?)/;

  for (const contents of sources) {
    for (const invocation of inlineShellInvocations(contents)) {
      assert.doesNotMatch(invocation, userArgument);
    }
  }
});

test('config keeps a deterministic one-entrypoint argument mapping', () => {
  const contents = body(readCommand('config'));
  const mappings = [
    '- No arguments: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}"`',
    '- `show`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}"`',
    '- `help` or `--help`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" help --project-dir "${CLAUDE_PROJECT_DIR}"`',
    '- `set <field> <value>`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" set "$FIELD" "$VALUE" --project-dir "${CLAUDE_PROJECT_DIR}"`',
    '- `unset <field>`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" unset "$FIELD" --project-dir "${CLAUDE_PROJECT_DIR}"`',
  ];
  const lines = contents.split('\n');

  assert.equal(nodeInvocations(contents), 5);
  for (const mapping of mappings) {
    assert.equal(lines.filter((line) => line === mapping).length, 1, mapping);
  }
  assert.match(contents, /map it to exactly one command/i);
  assert.match(contents, /An empty argument string is a complete request/i);
  assert.match(contents, /do not ask a question/i);
  assert.match(contents, /Reject any other argument shape/i);
  assert.match(contents, /final response exactly the first text content block/i);
});

test('help lists every user-invocable Prism command', () => {
  const contents = renderHelp();
  for (const name of ['setup', 'config', 'status', 'doctor', 'help', 'uninstall', 'realtime', 'report']) {
    assert.match(contents, new RegExp(`/prism:${name}\\b`));
  }
  assert.match(
    contents,
    /\/prism:uninstall\s+Preview removal of the current Prism install scope/,
  );
  assert.doesNotMatch(contents, /\/prism:uninstall[^\n]*all settings/i);
});

test('command prose never re-implements scoring or rendering math', () => {
  for (const name of ['report', 'doctor', 'status', 'realtime']) {
    const contents = body(readCommand(name));
    assert.doesNotMatch(contents, /0\.50|asymmetric|ln\(|GRADE_BANDS/i, `${name}.md must not contain scoring math`);
    assert.doesNotMatch(contents, /\| *# *\| *Check *\|/, `${name}.md must not contain a prose-rendered table spec`);
  }
});
