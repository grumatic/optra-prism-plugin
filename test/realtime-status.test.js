const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDirs = [];

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-realtime-status-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function freshModules(dataDir) {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  for (const key of Object.keys(require.cache)) {
    if (/lib[\\/](session|realtime|realtime-status)\.js$/.test(key)) delete require.cache[key];
  }
  return {
    session: require('../lib/session'),
    realtime: require('../lib/realtime'),
    status: require('../lib/realtime-status'),
  };
}

function seedSummary(session, sessionId, { turnCount, cost, input, unknownCost = false }) {
  return session.updateSummary(sessionId, (current) => ({
    ...current,
    consumedTotals: {
      input,
      cacheRead: 5000,
      cacheCreation: 0,
      output: 40,
      cost,
      unknownCost,
    },
    contextHealth: {
      ...current.contextHealth,
      turnCount,
      firstInputTokens: 1000,
      lastInputTokens: input,
      contextWindow: 200000,
    },
  }));
}

test('prints the exact Stop-hook summary line plus token detail for an explicit session', () => {
  const dataDir = makeDataDir();
  const { session, realtime, status } = freshModules(dataDir);
  seedSummary(session, 'realtime-status-exact', { turnCount: 3, cost: 0.7061, input: 12853 });

  const output = status.realtimeStatus(['--session', 'realtime-status-exact'], {});
  const summary = session.readSummary('realtime-status-exact');
  const lines = output.split('\n');

  assert.equal(lines[0], realtime.buildSystemMessage(summary));
  assert.match(lines[0], /^\[Prism\] Lite .+ · \$0\.706 · ctx \d+% · turn 3$/);
  assert.equal(lines[1], 'tokens: input 12,853 · cache read 5,000 · cache write 0 · output 40');
  assert.equal(lines.length, 2);
});

test('resolves the session from CLAUDE_CODE_SESSION_ID when no argument is given', () => {
  const dataDir = makeDataDir();
  const { session, status } = freshModules(dataDir);
  seedSummary(session, 'realtime-status-env', { turnCount: 1, cost: 0.1, input: 2000 });

  const output = status.realtimeStatus([], { CLAUDE_CODE_SESSION_ID: 'realtime-status-env' });
  assert.match(output.split('\n')[0], /turn 1$/);
  assert.doesNotMatch(output, /latest session/);
});

test('falls back to the most recent session with data and annotates it', () => {
  const dataDir = makeDataDir();
  const { session, status } = freshModules(dataDir);
  seedSummary(session, 'realtime-status-old', { turnCount: 2, cost: 0.2, input: 3000 });
  seedSummary(session, 'realtime-status-new', { turnCount: 7, cost: 0.9, input: 9000 });

  // Make the "old" session directory unambiguously older.
  const sessions = path.join(dataDir, 'runtime', 'sessions');
  const newHash = require('crypto').createHash('sha256').update('realtime-status-new').digest('hex');
  for (const entry of fs.readdirSync(sessions)) {
    if (entry !== newHash) {
      const stale = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(sessions, entry), stale, stale);
    }
  }

  const output = status.realtimeStatus([], { CLAUDE_CODE_SESSION_ID: 'realtime-status-missing' });
  const first = output.split('\n')[0];
  assert.match(first, /turn 7/);
  assert.match(first, / \(latest session\)$/);
});

test('reports no data when nothing has been recorded and flags approximate costs', () => {
  const emptyDir = makeDataDir();
  const { status } = freshModules(emptyDir);
  assert.match(status.realtimeStatus([], {}), /^No realtime data yet/);

  const dataDir = makeDataDir();
  const { session: session2, status: status2 } = freshModules(dataDir);
  seedSummary(session2, 'realtime-status-approx', { turnCount: 1, cost: 0.05, input: 1500, unknownCost: true });
  const output = status2.realtimeStatus(['--session', 'realtime-status-approx'], {});
  assert.match(output.split('\n')[0], /~\$0\.05/);
  assert.match(output, /cost is approximate/);
});
