// Architecture guard: command markdown stays a thin relay around one
// deterministic CLI entrypoint. Scripts compute AND render; the model only
// displays output verbatim. Prose renderers must not grow back.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { renderHelp } = require('../lib/help');

const ROOT = path.join(__dirname, '..');

function readCommand(name) {
  return fs.readFileSync(path.join(ROOT, 'commands', `${name}.md`), 'utf8');
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

test('commands reference only Claude Code substitution variables, never bogus ones', () => {
  for (const name of ['realtime', 'status', 'doctor', 'report', 'setup', 'config']) {
    const contents = body(readCommand(name));
    assert.doesNotMatch(contents, /\$PLUGIN_DIR|\$\{PLUGIN_DIR\}/, `${name}.md must not use $PLUGIN_DIR`);
    assert.doesNotMatch(contents, /CLAUDE_CODE_SESSION_ID/, `${name}.md must not use $CLAUDE_CODE_SESSION_ID`);
  }
});

test('read-only commands pre-authorize their node entrypoints', () => {
  for (const name of ['realtime', 'status', 'doctor', 'report']) {
    assert.match(
      frontmatter(readCommand(name)),
      /allowed-tools: Bash\(node:\*\)/,
      `${name}.md must declare allowed-tools`,
    );
  }
});

test('mutating and static commands keep the permission gate', () => {
  for (const name of ['setup', 'config', 'uninstall', 'help']) {
    assert.doesNotMatch(
      frontmatter(readCommand(name)),
      /allowed-tools/,
      `${name}.md must not pre-authorize tools`,
    );
  }
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
  assert.equal(nodeInvocations(contents), 1);
  assert.match(contents, /verbatim/i);
});

test('config is a thin relay to the deterministic config entrypoint', () => {
  const contents = readCommand('config');
  assert.match(contents, /lib\/config-command\.js/);
  assert.match(contents, /\bshow\b/);
  assert.match(contents, /\bset\b/);
  assert.match(contents, /\bunset\b/);
  assert.match(contents, /verbatim/i);
  assert.doesNotMatch(contents, /PRISM_(?:API_KEY|INGEST_URL)|CLAUDE_PLUGIN_OPTION/);
});

test('help lists every user-invocable Prism command', () => {
  const contents = renderHelp();
  for (const name of ['setup', 'config', 'status', 'doctor', 'help', 'uninstall', 'realtime', 'report']) {
    assert.match(contents, new RegExp(`/prism:${name}\\b`));
  }
});

test('command prose never re-implements scoring or rendering math', () => {
  for (const name of ['report', 'doctor', 'status', 'realtime']) {
    const contents = body(readCommand(name));
    assert.doesNotMatch(contents, /0\.50|asymmetric|ln\(|GRADE_BANDS/i, `${name}.md must not contain scoring math`);
    assert.doesNotMatch(contents, /\| *# *\| *Check *\|/, `${name}.md must not contain a prose-rendered table spec`);
  }
});
