#!/usr/bin/env node
/**
 * CLI renderer for the weekly Prism report. Keep scoring and display rules here
 * so /prism:report only invokes this deterministic entrypoint.
 */

const engine = require('./engine');

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_URL = 'https://dashboard.optra-prism.com/';
const GRADE_BANDS = [
  ['F', 0, 3], ['D', 3, 5], ['C', 5, 6], ['C+', 6, 6.5], ['B-', 6.5, 7],
  ['B', 7, 8], ['B+', 8, 8.5], ['A-', 8.5, 9], ['A', 9, 9.5], ['A+', 9.5, 10],
];
const BAR_GLYPHS = '▏▎▍▌▋▊▉█';

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function computeWindows(now = new Date()) {
  const end = new Date(now);
  const day = end.getUTCDay() || 7;
  const thisWeekStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - day + 1));
  const daysElapsed = end.getTime() - thisWeekStart.getTime();
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * DAY_MS);
  const lastWeekEnd = new Date(lastWeekStart.getTime() + daysElapsed);
  return {
    thisWeekStart: thisWeekStart.toISOString(),
    thisWeekEnd: end.toISOString(),
    lastWeekStart: lastWeekStart.toISOString(),
    lastWeekEnd: lastWeekEnd.toISOString(),
    thisWeek: { from: thisWeekStart.toISOString(), to: end.toISOString() },
    lastWeek: { from: lastWeekStart.toISOString(), to: lastWeekEnd.toISOString() },
    daysElapsed,
    dayOfWeek: end.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
  };
}

// Prism scoring spec §7: values at/below baseline lose points faster than gains add them.
function asymmetricMap10(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  const logged = Math.max(-1, Math.min(1, Math.log(ratio)));
  return logged >= 0 ? Math.min(7 + 3 * logged, 10) : Math.max(7 + 7 * logged, 0);
}

function scoreDetails(snapshot) {
  if (!snapshot) return null;
  const skill = Math.max(0, Math.min(10, number(snapshot.skill) / 10));
  const speed = asymmetricMap10(number(snapshot.speedHours) / 25);
  const efficiency = asymmetricMap10(75000 / number(snapshot.efficiencyTokensPerHour, NaN));
  return { score: 0.50 * skill + 0.30 * efficiency + 0.20 * speed, skill, speed, efficiency };
}

function prismScore(snapshot) {
  const details = scoreDetails(snapshot);
  return details ? details.score : null;
}

function gradeOf(score) {
  const value = Math.max(0, Math.min(10, number(score)));
  for (const [grade, from, to] of GRADE_BANDS) {
    if (value >= from && (value < to || (grade === 'A+' && value <= to))) return grade;
  }
  return 'F';
}

function renderBar(value, total) {
  const share = total > 0 ? Math.max(0, Math.min(1, number(value) / total)) : 0;
  const units = Math.round(share * 16 * 8);
  const full = Math.floor(units / 8);
  const remainder = units % 8;
  return '█'.repeat(full) + (remainder ? BAR_GLYPHS[remainder - 1] : '');
}

function aggregateTelemetry(records) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, tokensPerTurn: 0 };
  for (const record of Array.isArray(records) ? records : []) {
    if (record.event_name !== 'api_request') continue;
    let attributes = record.attributes_json;
    if (typeof attributes === 'string') {
      try { attributes = JSON.parse(attributes); } catch { attributes = {}; }
    }
    attributes = attributes && typeof attributes === 'object' ? attributes : {};
    totals.input += number(attributes.input_tokens);
    totals.output += number(attributes.output_tokens);
    totals.cacheRead += number(attributes.cache_read_tokens);
    totals.cacheWrite += number(attributes.cache_creation_tokens);
    totals.turns += 1;
  }
  totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  totals.tokensPerTurn = totals.turns ? totals.total / totals.turns : 0;
  return totals;
}

function formatNumber(value) {
  const absolute = Math.abs(number(value));
  const suffix = absolute >= 1e6 ? 'M' : absolute >= 1e3 ? 'k' : '';
  const divisor = suffix === 'M' ? 1e6 : suffix === 'k' ? 1e3 : 1;
  return `${(number(value) / divisor).toFixed(1)}${suffix}`;
}

function formatPlain(value) {
  return Math.round(number(value)).toLocaleString('en-US');
}

function formatCost(value) {
  return number(value).toFixed(2);
}

function signed(value, formatter = formatNumber) {
  const amount = number(value);
  return `${amount < 0 ? '−' : '+'}${formatter(Math.abs(amount))}`;
}

function movement(current, previous, threshold, relative = false) {
  const delta = number(current) - number(previous);
  const limit = relative ? Math.abs(number(previous)) * threshold : threshold;
  if (Math.abs(delta) < limit || (relative && !previous)) return { delta, arrow: '→' };
  return { delta, arrow: delta > 0 ? '↑' : '↓' };
}

function metricValue(report, names) {
  for (const name of names) {
    const value = name.split('.').reduce((current, key) => current && current[key], report);
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function reportMetrics(report) {
  return {
    sessions: metricValue(report, ['sessions', 'totalSessions', 'summary.sessions', 'howYouUseCc.stats.sessions']),
    cost: metricValue(report, ['totalCostUsd', 'costUsd', 'costOptimization.totalCostUsd', 'summary.totalCostUsd']),
    tokens: metricValue(report, ['totalTokens', 'tokens', 'summary.totalTokens'])
      || metricValue(report, ['totalInputTokens']) + metricValue(report, ['totalOutputTokens']),
  };
}

function proxyScore(report) {
  return metricValue(report, ['prismProfile.compositeScore']);
}

function dateOnly(iso) {
  return String(iso || '').slice(0, 10);
}

function comparisonRow(label, lastValue, thisValue, formatter, threshold, relative = false, noComparison = false, deltaFormatter = formatter) {
  if (noComparison) return `${label.padEnd(22)}—                 ${formatter(thisValue)}                 —`;
  const change = movement(thisValue, lastValue, threshold, relative);
  return `${label.padEnd(22)}${formatter(lastValue).padEnd(18)}${formatter(thisValue).padEnd(18)}${signed(change.delta, deltaFormatter).padEnd(10)}${change.arrow}`;
}

function weakestDimension(report) {
  const snapshot = report && report.pesRubricSnapshot;
  if (!snapshot) return null;
  const dimensions = [['CL', snapshot.clAvg], ['ID', snapshot.idAvg], ['TE', snapshot.teAvg], ['AC', snapshot.acAvg]]
    .filter(([, value]) => Number.isFinite(Number(value)));
  if (!dimensions.length) return null;
  return dimensions.sort((a, b) => number(a[1]) - number(b[1]))[0][0];
}

function focusFor(dimension) {
  return {
    ID: 'tighten density: cut filler, lead with verb + object, one ask per turn',
    CL: "leverage what's already loaded — name files, reference prior turns instead of re-pasting",
    TE: "bundle related changes; avoid 'also do X' follow-ups",
    AC: "kill demonstratives — replace 'fix it' with file:line + error string",
  }[dimension] || 'keep prompts specific and actionable';
}

function matchingCoaching(report, dimension) {
  const coaching = report && report.prismProfile && Array.isArray(report.prismProfile.coaching)
    ? report.prismProfile.coaching : [];
  return coaching.filter((entry) => String(entry.dimension || entry.key || entry.area || '').toUpperCase() === dimension);
}

function renderTokenUsage(current, previous) {
  if (!current || !previous || !current.turns || !previous.turns) return '';
  const rows = [['Input', 'input'], ['Output', 'output'], ['CacheR', 'cacheRead'], ['CacheW', 'cacheWrite']];
  const lines = ['Token usage (this week)', `Total       ${formatNumber(current.total)}`];
  for (const [label, key] of rows) {
    const change = movement(current[key], previous[key], 0.02, true);
    lines.push(`${label.padEnd(9)}${renderBar(current[key], current.total).padEnd(16)} ${formatNumber(current[key]).padStart(8)}    Δ ${signed(change.delta)}  ${change.arrow}`);
  }
  const perTurn = movement(current.tokensPerTurn, previous.tokensPerTurn, 0.02, true);
  lines.push(`${''.padEnd(26)}${formatPlain(current.turns)} turns`);
  lines.push(`${''.padEnd(12)}${formatNumber(current.tokensPerTurn)} tokens/turn  Δ ${signed(perTurn.delta)} ${perTurn.arrow}${perTurn.arrow === '↓' ? ' improving' : ''}`);
  return lines.join('\n');
}

function renderHabits(report) {
  const use = report && report.howYouUseCc;
  const stats = use && use.stats;
  if (!stats && !number(use && use.multiClaudingEvents)) return '';
  const lines = ['Habits'];
  if (stats && Number.isFinite(Number(stats.avgTurnsPerSession))) lines.push(`Avg turns/session: ${number(stats.avgTurnsPerSession).toFixed(1)}`);
  if (stats && Number.isFinite(Number(stats.medianResponseTimeSecs))) lines.push(`Median response: ${number(stats.medianResponseTimeSecs).toFixed(1)}s`);
  if (number(use && use.multiClaudingEvents) > 0) {
    lines.push(`Multi-clauding: ${formatPlain(use.multiClaudingEvents)} events across ${formatPlain(use.sessions || (stats && stats.sessions))} sessions — close extra Claude Code windows when working on one problem.`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function renderWorstPrompts(report) {
  const prompts = report && Array.isArray(report.worstPrompts) ? report.worstPrompts : [];
  if (!prompts.length) return '';
  const lines = ['Worst prompts', 'Score   Session   Turn   Prompt'];
  for (const prompt of prompts.slice().sort((a, b) => number(a.prismScore) - number(b.prismScore)).slice(0, 5)) {
    lines.push(`${number(prompt.prismScore).toFixed(1).padEnd(8)}${String(prompt.sessionId || prompt.session_id || '').slice(0, 8).padEnd(10)}${String(prompt.turnIndex ?? prompt.turn_index ?? '').padEnd(7)}${prompt.promptPreview || prompt.prompt_preview || ''}`);
  }
  return lines.join('\n');
}

function renderCoaching(report, dimension) {
  const tips = matchingCoaching(report, dimension);
  if (!tips.length) return '';
  const lines = ['Coaching', `Focus: ${tips[0].focus || tips[0].title || focusFor(dimension)}`];
  for (const tip of tips) {
    if (tip.tip) lines.push(tip.tip);
    if (tip.exampleBefore) lines.push(`Before: ${tip.exampleBefore}`);
    if (tip.exampleAfter) lines.push(`After: ${tip.exampleAfter}`);
  }
  return lines.join('\n');
}

function renderCostOptimization(report) {
  const cost = report && report.costOptimization;
  if (!cost || number(cost.totalCostUsd) === 0) return '';
  const actions = [...(Array.isArray(cost.modelRightsizing) ? cost.modelRightsizing : []), ...(Array.isArray(cost.wasteActions) ? cost.wasteActions : [])];
  if (!actions.length) return '';
  const lines = ['Cost optimization', `Total cost: $${formatCost(cost.totalCostUsd)}`, `Wasted: $${formatCost(cost.wastedCostUsd)} (${number(cost.wasteRatio).toFixed(1)}%)`, `Potential savings: $${formatCost(cost.potentialSavingsUsd)}`];
  for (const action of actions.sort((a, b) => number(b.savingsUsd || b.impactUsd || b.amountUsd) - number(a.savingsUsd || a.impactUsd || a.amountUsd)).slice(0, 3)) {
    if (action.action) lines.push(`- ${action.action}`);
  }
  return lines.join('\n');
}

function renderWhatChanged(last, current, lastScore, currentScore, noComparison) {
  if (noComparison) return 'What changed most: no comparison — first week of activity.';
  const candidates = [
    { name: 'PRISM', delta: currentScore - lastScore, bad: currentScore < lastScore, value: signed(currentScore - lastScore, (value) => value.toFixed(1)) },
    { name: 'Cost', delta: current.cost - last.cost, bad: current.cost > last.cost, value: signed(current.cost - last.cost, (value) => `$${formatCost(value)}`) },
  ];
  const bad = candidates.filter((item) => item.bad);
  const chosen = (bad.length ? bad : candidates).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  return `What changed most: ${chosen.name} ${chosen.value} ${bad.length ? '(needs attention)' : '(win to keep doing)'}.`;
}

function renderReport(data) {
  const thisWeek = data.thisWeek || data.current || data.this || {};
  const lastWeek = data.lastWeek || data.previous || data.last || {};
  const windows = data.windows || computeWindows(data.now || new Date());
  const thisSnapshot = thisWeek.skillSnapshot;
  const lastSnapshot = lastWeek.skillSnapshot;
  const useCanonical = Boolean(thisSnapshot && lastSnapshot);
  const thisScore = useCanonical ? prismScore(thisSnapshot) : proxyScore(thisWeek);
  const lastScore = useCanonical ? prismScore(lastSnapshot) : proxyScore(lastWeek);
  const thisMetrics = reportMetrics(thisWeek);
  const lastMetrics = reportMetrics(lastWeek);
  const noComparison = lastMetrics.sessions === 0;
  const prismLabel = useCanonical ? 'PRISM' : 'PRISM (rubric proxy)';
  const days = (number(windows.daysElapsed) / DAY_MS).toFixed(1);
  const lines = [
    `Period: ${dateOnly(windows.lastWeekStart)} → ${dateOnly(windows.thisWeekEnd)}  (this week vs last week, both Mon→${windows.dayOfWeek || 'now'}, ~${days}d each)`,
    '',
    'Comparison',
    `${''.padEnd(22)}Last week         This week         Δ`,
    comparisonRow(prismLabel, lastScore, thisScore, (value) => `${number(value).toFixed(1)}/10 (${gradeOf(value)})`, 0.1, false, noComparison, (value) => number(value).toFixed(1)),
    comparisonRow('Sessions', lastMetrics.sessions, thisMetrics.sessions, formatPlain, 0.05, true, noComparison),
    comparisonRow('Cost', lastMetrics.cost, thisMetrics.cost, (value) => `$${formatCost(value)}`, 1, false, noComparison),
    comparisonRow('Tokens', lastMetrics.tokens, thisMetrics.tokens, formatNumber, 0.05, true, noComparison),
  ];
  if (useCanonical) {
    lines.push(comparisonRow('Skill', number(lastSnapshot.skill), number(thisSnapshot.skill), (value) => `${number(value).toFixed(1)}/100`, 0.1, false, noComparison));
    lines.push(comparisonRow('Speed', number(lastSnapshot.speedHours), number(thisSnapshot.speedHours), (value) => `${number(value).toFixed(1)}h`, 0.1, false, noComparison));
    lines.push(comparisonRow('Efficiency', number(lastSnapshot.efficiencyTokensPerHour), number(thisSnapshot.efficiencyTokensPerHour), (value) => `${formatPlain(value)} tok/h`, 0.05, true, noComparison));
  }
  if (noComparison) lines.push('no comparison — first week of activity.');
  else if (gradeOf(lastScore) !== gradeOf(thisScore)) lines.push(`Grade ${thisScore > lastScore ? 'improved' : 'slipped'} ${gradeOf(lastScore)} → ${gradeOf(thisScore)}`);
  if (!useCanonical) {
    lines.push(thisSnapshot || lastSnapshot
      ? 'Layer 2/3 is not yet computed for one of these weeks — showing the rubric-average proxy for an apples-to-apples comparison.'
      : 'Layer 2/3 not yet computed for these weeks — showing the rubric-average proxy. Canonical PRISM (per spec §7) will appear once cadence workers populate Skill / Speed / Efficiency.');
  }
  const telemetry = data.telemetry || {};
  const tokenUsage = renderTokenUsage(telemetry.thisWeek || data.thisTelemetry, telemetry.lastWeek || data.lastTelemetry);
  const dimension = weakestDimension(thisWeek);
  const sections = [tokenUsage, renderHabits(thisWeek), renderWorstPrompts(thisWeek), renderCoaching(thisWeek, dimension), renderCostOptimization(thisWeek)].filter(Boolean);
  if (sections.length) lines.push('', sections.join('\n\n'));
  lines.push('', renderWhatChanged(lastMetrics, thisMetrics, lastScore, thisScore, noComparison));
  lines.push(`Focus area: ${focusFor(dimension)}`);
  lines.push(`🚀 Next: Open ${DASHBOARD_URL} for realtime coaching, full PRISM scores, deeper insights, and the LLM-narrated weekly review.`);
  return lines.join('\n');
}

async function fetchAllTelemetry(fetchTelemetryLogs, window) {
  const records = [];
  for (let page = 0; page < 30; page += 1) {
    const result = await fetchTelemetryLogs({ from: window.from, to: window.to, limit: 1000, offset: page * 1000 });
    if (!result || !result.ok) return null;
    const payload = result.data || {};
    const pageRecords = payload.records || payload.logs || payload.data || [];
    if (!Array.isArray(pageRecords)) return null;
    records.push(...pageRecords);
    if (!payload.has_more) break;
  }
  const aggregate = aggregateTelemetry(records);
  return aggregate.turns ? aggregate : null;
}

async function main(deps = {}) {
  const quickReport = deps.quickReport || engine.quickReport;
  const fetchTelemetryLogs = deps.fetchTelemetryLogs || engine.fetchTelemetryLogs;
  const now = deps.now || new Date();
  const windows = computeWindows(now);
  let thisResult;
  let lastResult;
  try {
    [thisResult, lastResult] = await Promise.all([quickReport(windows.thisWeek), quickReport(windows.lastWeek)]);
  } catch {
    const error = new Error(`Couldn't load this week's data — try the dashboard: ${DASHBOARD_URL}`);
    error.exitCode = 1;
    throw error;
  }
  if (!thisResult || !thisResult.ok || !lastResult || !lastResult.ok) {
    const failed = !thisResult || !thisResult.ok ? thisResult : lastResult;
    const status = failed && failed.detail && failed.detail.status;
    const error = new Error(`Couldn't load this week's data — try the dashboard: ${DASHBOARD_URL}`);
    error.exitCode = failed && (failed.reason === 'no_api_key' || failed.reason === 'no_ingest_url' || status === 401 || status === 403) ? 2 : 1;
    throw error;
  }
  const [thisTelemetry, lastTelemetry] = await Promise.all([
    fetchAllTelemetry(fetchTelemetryLogs, windows.thisWeek),
    fetchAllTelemetry(fetchTelemetryLogs, windows.lastWeek),
  ]);
  return renderReport({ thisWeek: thisResult.data || {}, lastWeek: lastResult.data || {}, windows, telemetry: { thisWeek: thisTelemetry, lastWeek: lastTelemetry } });
}

module.exports = { computeWindows, asymmetricMap10, prismScore, gradeOf, renderBar, aggregateTelemetry, renderReport, main };

if (require.main === module) {
  main().then((output) => {
    process.stdout.write(`${output}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message || `Couldn't load your report. Try the dashboard: ${DASHBOARD_URL}`}\n`);
    process.exitCode = error.exitCode || 1;
  });
}
