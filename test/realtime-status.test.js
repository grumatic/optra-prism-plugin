const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDirs = [];

function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-realtime-status-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.PRISM_INGEST_URL;
  delete process.env.PRISM_API_KEY;
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function freshModules(dataDir, ingestUrl) {
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  if (ingestUrl) {
    process.env.PRISM_INGEST_URL = ingestUrl;
    process.env.PRISM_API_KEY = 'prism_realtime_status_test';
  } else {
    delete process.env.PRISM_INGEST_URL;
    delete process.env.PRISM_API_KEY;
  }
  for (const key of Object.keys(require.cache)) {
    if (/lib[\\/](config|debug|env|ingest|session|realtime|realtime-status)\.js$/.test(key)) delete require.cache[key];
  }
  return {
    session: require('../lib/session'),
    status: require('../lib/realtime-status'),
  };
}

function seedSummary(session, sessionId, {
  turnCount,
  cost,
  input,
  unknownCost = false,
  serverScore = null,
  turnLog = [],
}) {
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
    },
    turnLog,
    serverScore,
  }));
}

async function startServer(rows, narrative) {
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/v1/score_v3/realtime/sub-sessions')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(rows));
      return;
    }
    if (request.url.startsWith('/v1/score_v3/today-summary')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ narrative }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('renders fresh server scores, sub-sessions, local cost, tokens, and today narrative', async () => {
  const server = await startServer([
    {
      sub_session_id: 'preview',
      is_preview: true,
      substance_floor_passed: true,
      letter_grade: 'B',
      intent_class: 'refactor_work',
      started_at: '2026-07-17T10:00:00.000Z',
    },
    {
      sub_session_id: 'settled',
      is_preview: false,
      substance_floor_passed: true,
      prompt_grade: 'B+',
      intent_class: 'bug_fix',
      goal_complete: true,
      started_at: '2026-07-17T10:02:00.000Z',
      ended_at: '2026-07-17T10:04:00.000Z',
    },
    {
      sub_session_id: 'scoring',
      is_preview: true,
      substance_floor_passed: true,
      started_at: '2026-07-17T10:04:00.000Z',
    },
    {
      sub_session_id: 'trivia',
      is_preview: false,
      substance_floor_passed: false,
      prompt_grade: 'A+',
      started_at: '2026-07-17T10:00:00.000Z',
    },
  ], 'Strong progress today.');
  try {
    const dataDir = makeDataDir();
    const { session, status } = freshModules(dataDir, server.url);
    seedSummary(session, 'realtime-status-exact', {
      turnCount: 3,
      cost: 0.7061,
      input: 12853,
      turnLog: [
        { turn: 1, completedAt: '2026-07-17T10:00:00.000Z' },
        { turn: 2, completedAt: '2026-07-17T10:02:00.000Z' },
        { turn: 3, completedAt: '2026-07-17T10:04:00.000Z' },
      ],
    });

    const output = await status.realtimeStatus(['--session', 'realtime-status-exact'], {});
    assert.match(output, /^\[Prism\] B live · refactor-work \(t1–3\) · \$0\.706 · 3 turns/m);
    assert.match(output, /^Session realtime/m);
    assert.match(output, /^  10:02  B\+  bug-fix ✓ \(t2–3\)  settled/m);
    assert.match(output, /^  10:04  —\s+ — \(t3\)  scoring/m);
    assert.doesNotMatch(output, /trivia/);
    assert.match(output, /^  cost \$0\.706 · 3 turns/m);
    assert.match(output, /^tokens: input 12,853 · cache read 5,000 · cache write 0 · output 40/m);
    assert.match(output, /^Today\nStrong progress today\.$/m);
  } finally {
    await server.close();
  }
});

test('uses a cached server score when realtime fetching fails and resolves the session from the environment', async () => {
  const dataDir = makeDataDir();
  const { session, status } = freshModules(dataDir);
  seedSummary(session, 'realtime-status-env', {
    turnCount: 1,
    cost: 0.1,
    input: 2000,
    turnLog: [{ turn: 1, completedAt: '2026-07-17T10:00:00.000Z' }],
    serverScore: {
      state: 'settled',
      grade: 'A-',
      intent: 'feature_work',
      goalComplete: true,
      rework: false,
      turnStart: 1,
      turnEnd: 1,
      subSessionId: 'cached',
      fetchedAt: '2026-07-17T10:00:01.000Z',
    },
  });

  const output = await status.realtimeStatus([], { CLAUDE_CODE_SESSION_ID: 'realtime-status-env' });
  assert.match(output.split('\n')[0], /^\[Prism\] A- · feature-work ✓ \(t1\) · \$0\.100 · 1 turns$/);
  assert.doesNotMatch(output, /latest session/);
});

test('falls back to the most recent session with data and annotates it', async () => {
  const dataDir = makeDataDir();
  const { session, status } = freshModules(dataDir);
  seedSummary(session, 'realtime-status-old', { turnCount: 2, cost: 0.2, input: 3000 });
  seedSummary(session, 'realtime-status-new', { turnCount: 7, cost: 0.9, input: 9000 });

  const sessions = path.join(dataDir, 'runtime', 'sessions');
  const newHash = require('crypto').createHash('sha256').update('realtime-status-new').digest('hex');
  for (const entry of fs.readdirSync(sessions)) {
    if (entry !== newHash) {
      const stale = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(sessions, entry), stale, stale);
    }
  }

  const output = await status.realtimeStatus([], { CLAUDE_CODE_SESSION_ID: 'realtime-status-missing' });
  assert.match(output.split('\n')[0], /^\[Prism\] no score · \$0\.900 · 7 turns \(latest session\)$/);
});

test('reports no data and flags approximate local costs', async () => {
  const emptyDir = makeDataDir();
  const { status } = freshModules(emptyDir);
  assert.match(await status.realtimeStatus([], {}), /^No realtime data yet/);

  const dataDir = makeDataDir();
  const { session, status: status2 } = freshModules(dataDir);
  seedSummary(session, 'realtime-status-approx', { turnCount: 1, cost: 0.05, input: 1500, unknownCost: true });
  const output = await status2.realtimeStatus(['--session', 'realtime-status-approx'], {});
  assert.match(output.split('\n')[0], /~\$0\.05/);
  assert.match(output, /cost is approximate/);
});
