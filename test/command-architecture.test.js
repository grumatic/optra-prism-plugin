// Architecture guard: command markdown stays a thin relay around one
// deterministic CLI entrypoint. Scripts compute AND render; the model only
// displays output verbatim. Prose renderers must not grow back.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

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
  return (body(contents).match(/node "\$PLUGIN_DIR/g) || []).length;
}

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
  for (const name of ['setup', 'uninstall', 'help']) {
    assert.doesNotMatch(
      frontmatter(readCommand(name)),
      /allowed-tools/,
      `${name}.md must not pre-authorize tools`,
    );
  }
});

test('deterministic commands are a single entrypoint call plus verbatim display', () => {
  for (const name of ['doctor', 'report']) {
    const contents = readCommand(name);
    assert.equal(nodeInvocations(contents), 1, `${name}.md must call exactly one entrypoint`);
    assert.match(contents, /verbatim/i, `${name}.md must display output verbatim`);
    assert.ok(
      body(contents).split('\n').length <= 25,
      `${name}.md body must stay under the line budget`,
    );
  }
});

test('status keeps one entrypoint plus the conversational toggle appendix', () => {
  const contents = readCommand('status');
  assert.equal(nodeInvocations(contents), 1);
  assert.match(contents, /verbatim/i);
  assert.match(contents, /showRealtimeSummary/);
});

test('command prose never re-implements scoring or rendering math', () => {
  for (const name of ['report', 'doctor', 'status', 'realtime']) {
    const contents = body(readCommand(name));
    assert.doesNotMatch(contents, /0\.50|asymmetric|ln\(|GRADE_BANDS/i, `${name}.md must not contain scoring math`);
    assert.doesNotMatch(contents, /\| *# *\| *Check *\|/, `${name}.md must not contain a prose-rendered table spec`);
  }
});
