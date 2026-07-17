/**
 * CLI for the /prism:realtime command: prints the latest realtime session
 * summary from local runtime state. Read-only pull surface for hosts that do
 * not render hook systemMessage output (e.g. the VS Code extension GUI); the
 * Stop-hook push display on the CLI is unaffected.
 *
 * Session resolution: --session argument, then CLAUDE_CODE_SESSION_ID, then
 * the most recently modified session record (annotated as "latest session").
 */

const fs = require('fs');
const path = require('path');
const { readSummary } = require('./session');
const { fetchRealtimeSubSessions, fetchTodaySummary } = require('./ingest');
const { formatCost, mapTurnRange, renderScoreLine, selectScoreRow } = require('./realtime');

function getRuntimeSessionsDir() {
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(require('os').homedir(), '.prism');
  return path.join(dataDir, 'runtime', 'sessions');
}

// Recover the raw session id from the newest session directory. Record files
// carry their own sessionId, so no hash reversal is needed; the official
// readSummary() then performs the fence-major, reconciled read.
function latestSessionId() {
  const sessionsDir = getRuntimeSessionsDir();
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => {
        const dir = path.join(sessionsDir, entry.name);
        try { return { dir, mtimeMs: fs.statSync(dir).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }
  for (const { dir } of entries) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!/^(summary|turn)\.g\d+(\.f\d+)?\.json$/.test(file)) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (record && typeof record.sessionId === 'string' && record.sessionId) return record.sessionId;
      } catch {}
    }
  }
  return null;
}

function formatTokens(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

function scoreFromRow(selected, summary) {
  if (!selected) return { state: 'scoring' };
  const { row, state } = selected;
  const range = mapTurnRange(
    summary.turnLog,
    row,
    summary.contextHealth.turnCount,
  );
  return {
    state,
    grade: state === 'live' ? row.letter_grade : (row.prompt_grade || row.letter_grade),
    intent: row.intent_class || null,
    goalComplete: row.goal_complete === true,
    rework: row.rework === true,
    turnStart: range.turnStart,
    turnEnd: range.turnEnd,
    subSessionId: row.sub_session_id,
    fetchedAt: new Date().toISOString(),
  };
}

function formatSessionTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 16) : '--:--';
}

function formatSessionRow(row, summary) {
  const isLive = row.is_preview === true;
  const grade = isLive ? row.letter_grade : (row.prompt_grade || row.letter_grade);
  const state = isLive ? (grade ? 'live' : 'scoring') : 'settled';
  const range = mapTurnRange(summary.turnLog, row, summary.contextHealth.turnCount);
  const turns = range.turnStart === range.turnEnd
    ? `(t${range.turnStart})`
    : `(t${range.turnStart}–${range.turnEnd})`;
  const intent = typeof row.intent_class === 'string' && row.intent_class.length > 0
    ? row.intent_class.replace(/_/g, '-')
    : '—';
  const markers = state === 'settled'
    ? `${row.goal_complete === true ? ' ✓' : ''}${row.rework === true ? ' ↺' : ''}`
    : '';
  return `  ${formatSessionTime(row.started_at)}  ${(grade || '—').padEnd(2)}  ${intent}${markers} ${turns}  ${state}`;
}

async function realtimeStatus(argv, env) {
  // In command context (unlike hooks) the ambient CLAUDE_PLUGIN_DATA can carry
  // another plugin's data dir. The command passes the correct value through
  // --data-dir (from the ${CLAUDE_PLUGIN_DATA} substitution); apply it before
  // any session read so getRuntimeSessionsDir() resolves the Prism dir.
  const dataDirIndex = argv.indexOf('--data-dir');
  const dataDir = dataDirIndex !== -1 ? argv[dataDirIndex + 1] : undefined;
  if (typeof dataDir === 'string' && dataDir) process.env.CLAUDE_PLUGIN_DATA = dataDir;

  const sessionArgIndex = argv.indexOf('--session');
  const explicit = sessionArgIndex !== -1 ? argv[sessionArgIndex + 1] : undefined;
  const envSession = typeof env.CLAUDE_SESSION_ID === 'string' && env.CLAUDE_SESSION_ID
    ? env.CLAUDE_SESSION_ID
    : (typeof env.CLAUDE_CODE_SESSION_ID === 'string' && env.CLAUDE_CODE_SESSION_ID
      ? env.CLAUDE_CODE_SESSION_ID
      : undefined);

  let annotation = '';
  let sessionId = explicit || envSession;
  let summary = sessionId ? readSummary(sessionId) : null;

  if (!summary || !summary.contextHealth || !(summary.contextHealth.turnCount > 0)) {
    const fallback = latestSessionId();
    if (fallback && fallback !== sessionId) {
      const fallbackSummary = readSummary(fallback);
      if (fallbackSummary && fallbackSummary.contextHealth && fallbackSummary.contextHealth.turnCount > 0) {
        sessionId = fallback;
        summary = fallbackSummary;
        annotation = ' (latest session)';
      }
    }
  }

  if (!summary || !summary.contextHealth || !(summary.contextHealth.turnCount > 0)) {
    return 'No realtime data yet for this session. The summary fills in after the first completed prompt.';
  }

  const [rows, today] = await Promise.all([
    fetchRealtimeSubSessions({ claudeSessionId: sessionId, limit: 50 }),
    fetchTodaySummary({ date: new Date().toISOString().slice(0, 10) }),
  ]);
  const serverScore = Array.isArray(rows)
    ? scoreFromRow(selectScoreRow(rows), summary)
    : summary.serverScore || { state: 'no score' };
  const totals = summary.consumedTotals;
  const lines = [
    `${renderScoreLine(serverScore, totals.cost, totals.unknownCost, summary.contextHealth.turnCount)}${annotation}`,
  ];

  if (Array.isArray(rows)) {
    lines.push('', `Session ${sessionId.slice(0, 8)}`);
    for (const row of rows) {
      if (row && typeof row === 'object' && row.substance_floor_passed !== false) {
        lines.push(formatSessionRow(row, summary));
      }
    }
  }
  lines.push(`  cost ${formatCost(totals.cost, totals.unknownCost)} · ${summary.contextHealth.turnCount} turns`);
  lines.push(
    `tokens: input ${formatTokens(totals.input)} · cache read ${formatTokens(totals.cacheRead)} · cache write ${formatTokens(totals.cacheCreation)} · output ${formatTokens(totals.output)}`,
  );
  if (totals.unknownCost) {
    lines.push('cost is approximate: some usage came from models without a reviewed price.');
  }
  if (today && typeof today.narrative === 'string' && today.narrative.length > 0) {
    lines.push('', 'Today', today.narrative);
  }
  return lines.join('\n');
}

module.exports = { realtimeStatus, latestSessionId };

if (require.main === module) {
  realtimeStatus(process.argv.slice(2), process.env)
    .then((output) => process.stdout.write(`${output}\n`))
    .catch(() => process.stdout.write('No realtime data yet for this session. The summary fills in after the first completed prompt.\n'));
}
