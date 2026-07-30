'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const READ_COMMANDS = Object.freeze({
  doctor: {
    agent: 'prism-output',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true',
  },
  help: {
    agent: 'prism-output',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" 2>&1 || true',
  },
  realtime: {
    agent: 'prism-output',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}"',
  },
  report: {
    agent: 'prism-output',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/report.js" 2>&1 || true',
  },
  status: {
    agent: 'prism-status',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true',
  },
});

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

test('shared read executor is a bounded foreground Haiku agent', () => {
  const agent = read('agents/prism-output.md');
  const agentMetadata = frontmatter(agent);

  assert.match(agentMetadata, /^name: prism-output$/m);
  assert.match(agentMetadata, /^model: haiku$/m);
  assert.match(agentMetadata, /^tools: \["Bash"\]$/m);
  assert.match(agentMetadata, /^background: false$/m);
  assert.match(agentMetadata, /^maxTurns: 2$/m);
  assert.match(agent, /Run that exact Bash command once/i);
  assert.match(agent, /character-for-character/i);
});

test('status executor is a bounded foreground Haiku agent', () => {
  const agent = read('agents/prism-status.md');
  const agentMetadata = frontmatter(agent);

  assert.match(agentMetadata, /^name: prism-status$/m);
  assert.match(agentMetadata, /^model: haiku$/m);
  assert.match(agentMetadata, /^tools: \["Bash"\]$/m);
  assert.match(agentMetadata, /^background: false$/m);
  assert.match(agentMetadata, /^maxTurns: 2$/m);
  assert.match(agent, /Run that exact Bash command once/i);
  assert.match(agent, /character-for-character/i);
});

test('read controllers expose execution steps and reserve final assistant output', () => {
  for (const [commandName, contract] of Object.entries(READ_COMMANDS)) {
    const contents = read(`commands/${commandName}.md`);
    const metadata = frontmatter(contents);
    const commandBody = body(contents);
    const permissions = [...metadata.matchAll(/^  - (Bash\(.*\))$/gm)].map((match) => match[1]);

    assert.match(metadata, /^user-invocable: true$/m, commandName);
    assert.match(metadata, /^disable-model-invocation: true$/m, commandName);
    assert.match(metadata, /^model: haiku$/m, commandName);
    assert.doesNotMatch(metadata, /^(?:context|background|agent):/m, commandName);
    assert.match(
      metadata,
      new RegExp(`^  - Agent\\(prism:${contract.agent}\\)$`, 'm'),
      commandName,
    );
    assert.deepEqual(inlineShellInvocations(contents), [], commandName);
    assert.equal(commandBody.split(contract.invocation).length - 1, 1, commandName);
    assert.match(
      commandBody,
      new RegExp(`Use the \`prism:${contract.agent}\` Agent exactly once`, 'i'),
      commandName,
    );
    assert.match(commandBody, /final response exactly the first text content block/i, commandName);
    assert.match(
      commandBody,
      /Ignore\s+the continuation `agentId` and usage metadata/i,
      commandName,
    );
    assert.match(commandBody, /Do not call Bash or any other tool yourself/i, commandName);

    if (commandName === 'realtime') {
      assert.doesNotMatch(contract.invocation, /2>&1|\|\|/, commandName);
    } else {
      assert.match(contract.invocation, / 2>&1 \|\| true$/, commandName);
      assert.equal((contract.invocation.match(/2>&1/g) || []).length, 1, commandName);
      assert.equal((contract.invocation.match(/\|\| true/g) || []).length, 1, commandName);
    }
    assert.deepEqual(permissions, [`Bash(${contract.invocation})`], commandName);
    assert.doesNotMatch(metadata, /Bash\(node:\*\)|Bash\(node \*\)|:\*\)/, commandName);
    assert.equal((metadata.match(/\*/g) || []).length, 0);
    assert.doesNotMatch(
      contract.invocation,
      /\$(?:\{?ARGUMENTS\}?|\{?\d+\}?)/,
      commandName,
    );
  }
});

test('status and doctor receive the host project and plugin data directories exactly once', () => {
  const invocations = {
    status: READ_COMMANDS.status.invocation,
    doctor: READ_COMMANDS.doctor.invocation,
  };
  for (const [commandName, invocation] of Object.entries(invocations)) {
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

test('a failing read entrypoint is normalized into relayable stdout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-read-error-'));
  const invocation = READ_COMMANDS.report.invocation
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
