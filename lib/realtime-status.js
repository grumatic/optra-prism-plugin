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
const { buildSystemMessage } = require('./realtime');

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

function realtimeStatus(argv, env) {
  const sessionArgIndex = argv.indexOf('--session');
  const explicit = sessionArgIndex !== -1 ? argv[sessionArgIndex + 1] : undefined;
  const envSession = typeof env.CLAUDE_CODE_SESSION_ID === 'string' && env.CLAUDE_CODE_SESSION_ID
    ? env.CLAUDE_CODE_SESSION_ID
    : undefined;

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

  const totals = summary.consumedTotals;
  const lines = [
    `${buildSystemMessage(summary)}${annotation}`,
    `tokens: input ${formatTokens(totals.input)} · cache read ${formatTokens(totals.cacheRead)} · cache write ${formatTokens(totals.cacheCreation)} · output ${formatTokens(totals.output)}`,
  ];
  if (totals.unknownCost) {
    lines.push('cost is approximate: some usage came from models without a reviewed price.');
  }
  return lines.join('\n');
}

module.exports = { realtimeStatus, latestSessionId };

if (require.main === module) {
  process.stdout.write(`${realtimeStatus(process.argv.slice(2), process.env)}\n`);
}
