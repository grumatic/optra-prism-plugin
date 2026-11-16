'use strict';

require('./helpers/isolate-claude-env');

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
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --relay-output',
  },
  help: {
    agent: 'prism-output',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" --relay-output',
  },
  realtime: {
    agent: 'prism-output',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}"',
  },
  report: {
    agent: 'prism-output',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/report.js" --relay-output',
  },
  status: {
    agent: 'prism-status',
    invocation: 'node "${CLAUDE_PLUGIN_ROOT}/lib/status.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --relay-output',
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
  assert.match(agentMetadata, /^tools: \["Bash", "PowerShell"\]$/m);
  assert.match(agentMetadata, /^background: false$/m);
  assert.match(agentMetadata, /^maxTurns: 2$/m);
  assert.match(agent, /Run that exact command once, with the Bash tool or, when Bash is unavailable,\s+with the PowerShell tool/i);
  assert.match(agent, /character-for-character/i);
});

test('status executor is a bounded foreground Haiku agent', () => {
  const agent = read('agents/prism-status.md');
  const agentMetadata = frontmatter(agent);

  assert.match(agentMetadata, /^name: prism-status$/m);
  assert.match(agentMetadata, /^model: haiku$/m);
  assert.match(agentMetadata, /^tools: \["Bash", "PowerShell"\]$/m);
  assert.match(agentMetadata, /^background: false$/m);
  assert.match(agentMetadata, /^maxTurns: 2$/m);
  assert.match(agent, /Run that exact command once, with the Bash tool or, when Bash is unavailable,\s+with the PowerShell tool/i);
  assert.match(agent, /character-for-character/i);
});

test('read controllers expose execution steps and reserve final assistant output', () => {
  for (const [commandName, contract] of Object.entries(READ_COMMANDS)) {
    const contents = read(`commands/${commandName}.md`);
    const metadata = frontmatter(contents);
    const commandBody = body(contents);
    const permissions = [...metadata.matchAll(/^  - ((?:Bash|PowerShell)\(.*\))$/gm)].map((match) => match[1]);

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
    assert.match(commandBody, /Do not call Bash, PowerShell, or any other tool yourself/i, commandName);
    assert.doesNotMatch(contents, /2>&1|\|\| true/, commandName);

    assert.doesNotMatch(contract.invocation, /2>&1|\|\||;|&&/, commandName);
    assert.equal(
      (contract.invocation.match(/--relay-output/g) || []).length,
      commandName === 'realtime' ? 0 : 1,
      commandName,
    );
    assert.deepEqual(
      permissions,
      [`Bash(${contract.invocation})`, `PowerShell(${contract.invocation})`],
      commandName,
    );
    assert.doesNotMatch(metadata, /\(node:\*\)|\(node \*\)|:\*\)/, commandName);
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
      / --project-dir "\$\{CLAUDE_PROJECT_DIR\}" --data-dir "\$\{CLAUDE_PLUGIN_DATA\}" --relay-output$/,
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

function runEntrypoint(home, script, args) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
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
  return spawnSync(process.execPath, [path.join(ROOT, 'lib', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
}

test('report --relay-output moves the failure text to stdout and exits 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-read-error-'));
  const message = "Couldn't load this week's data — try the dashboard: "
    + 'https://dashboard.optra-prism.com/\n';

  try {
    const relayed = runEntrypoint(home, 'report.js', ['--relay-output']);
    assert.equal(relayed.status, 0);
    assert.equal(relayed.stderr, '');
    assert.equal(relayed.stdout, message);

    const plain = runEntrypoint(home, 'report.js', []);
    assert.equal(plain.status, 2);
    assert.equal(plain.stdout, '');
    assert.equal(plain.stderr, message);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor and status --relay-output move argument errors to stdout and exit 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-read-error-'));

  try {
    for (const name of ['doctor', 'status']) {
      const script = `${name}.js`;
      const bad = ['--data-dir', 'relative/dir'];
      const text = `[prism:${name}] --data-dir must be an absolute path\n`;

      const relayed = runEntrypoint(home, script, [...bad, '--relay-output']);
      assert.equal(relayed.status, 0, name);
      assert.equal(relayed.stderr, '', name);
      assert.equal(relayed.stdout, text, name);

      const plain = runEntrypoint(home, script, bad);
      assert.equal(plain.status, 2, name);
      assert.equal(plain.stdout, '', name);
      assert.equal(plain.stderr, text, name);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('help --relay-output prints the same text and exits 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-read-error-'));

  try {
    const relayed = runEntrypoint(home, 'help.js', ['--relay-output']);
    const plain = runEntrypoint(home, 'help.js', []);
    assert.equal(relayed.status, 0);
    assert.equal(relayed.stderr, '');
    assert.equal(relayed.stdout, `${require('../lib/help').renderHelp()}\n`);
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, relayed.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('relay-output keeps stderr and stdout order and survives a thrown error', () => {
  const relayModule = path.join(ROOT, 'lib', 'relay-output.js');
  const script = `
    const { runCli } = require(${JSON.stringify(relayModule)});
    runCli(async (argv) => {
      process.stdout.write('out1\\n');
      process.stderr.write('err1\\n');
      process.stdout.write('out2\\n');
      process.stderr.write('args:' + argv.join(',') + '\\n');
      throw new Error('boom');
    }, { argv: ['a', '--relay-output'] });
  `;
  const relayed = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(relayed.status, 0);
  assert.equal(relayed.stderr, '');
  assert.equal(relayed.stdout, 'out1\nerr1\nout2\nargs:a\nboom\n');
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
