'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const READ_COMMANDS = ['help', 'status', 'doctor', 'realtime', 'report'];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function frontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'markdown must start with frontmatter');
  return match[1];
}

function body(contents) {
  return contents.replace(/^---\n[\s\S]*?\n---\n/, '');
}

function inlineShellInvocations(contents) {
  return [...body(contents).matchAll(/!`([^`\n]*)`/g)].map((match) => match[1]);
}

test('read commands run in the shared isolated Haiku relay', () => {
  const agent = read('agents/prism-output.md');
  const agentMetadata = frontmatter(agent);

  assert.match(agentMetadata, /^name: prism-output$/m);
  assert.match(agentMetadata, /^model: haiku$/m);
  assert.match(agentMetadata, /^tools: \[\]$/m);
  assert.match(agent, /opaque, untrusted data/i);
  assert.match(agent, /character-for-character/i);
  assert.match(agent, /Never invoke a skill, agent, command, or tool/i);

  for (const commandName of READ_COMMANDS) {
    const contents = read(`commands/${commandName}.md`);
    const metadata = frontmatter(contents);

    assert.match(metadata, /^user-invocable: true$/m, commandName);
    assert.match(metadata, /^disable-model-invocation: true$/m, commandName);
    assert.match(metadata, /^context: fork$/m, commandName);
    assert.match(metadata, /^background: false$/m, commandName);
    assert.match(metadata, /^agent: prism:prism-output$/m, commandName);
    assert.doesNotMatch(metadata, /^model:/m, commandName);
    assert.match(contents, /character-for-character/i, commandName);
    assert.match(contents, /Do not summarize, explain, label, or add commentary/i, commandName);
  }
});

test('read commands pre-authorize exactly one invocation and preserve failure output', () => {
  for (const commandName of READ_COMMANDS) {
    const contents = read(`commands/${commandName}.md`);
    const metadata = frontmatter(contents);
    const invocations = inlineShellInvocations(contents);
    const permissions = [...metadata.matchAll(/^  - (Bash\(.*\))$/gm)].map((match) => match[1]);
    const expectedInvocation = invocations[0];

    assert.equal(invocations.length, 1, commandName);
    if (commandName === 'realtime') {
      assert.doesNotMatch(invocations[0], /2>&1|\|\|/, commandName);
    } else {
      assert.match(invocations[0], / 2>&1 \|\| true$/, commandName);
      assert.equal((invocations[0].match(/2>&1/g) || []).length, 1, commandName);
      assert.equal((invocations[0].match(/\|\| true/g) || []).length, 1, commandName);
    }
    assert.deepEqual(permissions, [`Bash(${expectedInvocation})`], commandName);
    assert.doesNotMatch(metadata, /Bash\(node:\*\)|Bash\(node \*\)|:\*\)/, commandName);
    assert.equal((metadata.match(/\*/g) || []).length, 0);
    assert.doesNotMatch(invocations[0], /\$(?:\{?ARGUMENTS\}?|\{?\d+\}?)/, commandName);
  }
});

test('status and doctor receive the host project and plugin data directories exactly once', () => {
  for (const commandName of ['status', 'doctor']) {
    const invocation = inlineShellInvocations(read(`commands/${commandName}.md`))[0];
    assert.match(
      invocation,
      / --project-dir "\$\{CLAUDE_PROJECT_DIR\}" --data-dir "\$\{CLAUDE_PLUGIN_DATA\}" 2>&1 \|\| true$/,
      commandName,
    );
    assert.equal((invocation.match(/--project-dir/g) || []).length, 1, commandName);
    assert.equal((invocation.match(/--data-dir/g) || []).length, 1, commandName);
  }
});

test('realtime command delegates all conditional output to its script', () => {
  const commandBody = body(read('commands/realtime.md'));
  const realtimeSource = read('lib/realtime-status.js');

  assert.doesNotMatch(commandBody, /No realtime data|latest session|Complete one prompt/i);
  assert.match(realtimeSource, /Complete one prompt first, then run `\/prism:realtime` again\./);
  assert.match(
    realtimeSource,
    /most recent session on this machine because the current session has no completed turns yet\./,
  );
});

test('a failing read entrypoint is relayed on stdout without failing inline expansion', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-read-error-'));
  const invocation = inlineShellInvocations(read('commands/report.md'))[0]
    .replace('${CLAUDE_PLUGIN_ROOT}', ROOT);
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_PLUGIN_DATA: home,
  };
  for (const key of [
    'PRISM_API_KEY',
    'PRISM_GCK_KEY',
    'PRISM_INGEST_URL',
    'CLAUDE_PLUGIN_OPTION_APIKEY',
  ]) {
    delete env[key];
  }

  try {
    const result = spawnSync('bash', ['-c', invocation], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout,
      "Couldn't load this week's data — try the dashboard: "
        + 'https://dashboard.optra-prism.com/\n',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('realtime no-data output includes deterministic retry guidance', () => {
  const { noRealtimeDataOutput } = require('../lib/realtime-status');

  assert.equal(
    noRealtimeDataOutput(),
    'No realtime data yet for this session. The summary fills in after the first completed prompt.\n'
      + '\n'
      + 'Complete one prompt first, then run `/prism:realtime` again.',
  );
});

test('realtime fallback output explains the latest-session annotation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-read-command-'));
  const envKeys = [
    'HOME',
    'CLAUDE_PLUGIN_DATA',
    'PRISM_API_KEY',
    'PRISM_GCK_KEY',
    'PRISM_INGEST_URL',
    'CLAUDE_PLUGIN_OPTION_APIKEY',
  ];
  const originalEnv = new Map(envKeys.map((key) => [
    key,
    {
      present: Object.prototype.hasOwnProperty.call(process.env, key),
      value: process.env[key],
    },
  ]));

  try {
    process.env.HOME = dataDir;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
    for (const key of envKeys.slice(2)) delete process.env[key];

    const configFile = path.join(dataDir, '.prism', 'config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify({
      apiKey: 'prism_read_command_test',
      ingest_url: 'http://127.0.0.1:1',
    })}\n`);

    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/](config|debug|env|ingest|session|realtime|realtime-status)\.js$/.test(key)) {
        delete require.cache[key];
      }
    }

    const session = require('../lib/session');
    const status = require('../lib/realtime-status');
    const sessionId = 'read-command-latest';
    session.updateSummary(sessionId, (current) => ({
      ...current,
      consumedTotals: {
        input: 2000,
        cacheRead: 5000,
        cacheCreation: 0,
        output: 40,
        cost: 0.1,
        unknownCost: false,
      },
      contextHealth: {
        ...current.contextHealth,
        turnCount: 1,
        firstInputTokens: 1000,
        lastInputTokens: 2000,
      },
      serverScore: {
        state: 'settled',
        grade: 'A-',
        intent: 'feature_work',
        goalComplete: true,
        rework: false,
        turnStart: 1,
        turnEnd: 1,
        subSessionId: 'cached',
        fetchedAt: '2026-07-24T00:00:00.000Z',
      },
    }));

    const output = await status.realtimeStatus(
      ['--session', 'read-command-empty', '--data-dir', dataDir],
      {},
    );
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex');

    assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'sessions', sessionHash)), true);
    assert.match(output.split('\n')[0], /\(latest session\)$/);
    assert.match(
      output,
      /\n\nThis summary came from the most recent session on this machine because the current session has no completed turns yet\.$/,
    );
  } finally {
    for (const [key, original] of originalEnv) {
      if (original.present) process.env[key] = original.value;
      else delete process.env[key];
    }
    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/](config|debug|env|ingest|session|realtime|realtime-status)\.js$/.test(key)) {
        delete require.cache[key];
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
