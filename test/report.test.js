const test = require('node:test');
const assert = require('node:assert');

const {
  aggregateTelemetry,
  asymmetricMap10,
  computeWindows,
  gradeOf,
  renderBar,
  renderReport,
} = require('../lib/report');

test('asymmetricMap10 applies the section 7 baseline and clipped logarithm', () => {
  assert.equal(asymmetricMap10(1), 7);
  assert.equal(asymmetricMap10(Math.E), 10);
  assert.equal(asymmetricMap10(1 / Math.E), 0);
  assert.equal(asymmetricMap10(Math.exp(-0.5)), 3.5);
});

test('gradeOf honors half-open grade bands and closes A+', () => {
  assert.equal(gradeOf(6.99), 'B-');
  assert.equal(gradeOf(7), 'B');
  assert.equal(gradeOf(9.5), 'A+');
  assert.equal(gradeOf(10), 'A+');
});

test('computeWindows creates equally long, day-aligned ISO windows', () => {
  const windows = computeWindows(new Date('2026-07-15T10:30:00.000Z'));
  assert.equal(windows.thisWeekStart, '2026-07-13T00:00:00.000Z');
  assert.equal(new Date(windows.thisWeekEnd) - new Date(windows.thisWeekStart), new Date(windows.lastWeekEnd) - new Date(windows.lastWeekStart));
  assert.equal(new Date(windows.lastWeekStart).getTime(), new Date(windows.thisWeekStart).getTime() - 7 * 24 * 60 * 60 * 1000);
});

test('aggregateTelemetry sums api requests and derives turns and tokens per turn', () => {
  const totals = aggregateTelemetry([
    { event_name: 'api_request', attributes_json: JSON.stringify({ input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_creation_tokens: 10 }) },
    { event_name: 'other', attributes_json: '{}' },
    { event_name: 'api_request', attributes_json: { input_tokens: 50, output_tokens: 5, cache_read_tokens: 15, cache_creation_tokens: 0 } },
  ]);
  assert.deepEqual(totals, { input: 150, output: 25, cacheRead: 45, cacheWrite: 10, total: 230, turns: 2, tokensPerTurn: 115 });
});

test('renderBar is proportional and never exceeds sixteen characters', () => {
  assert.equal(renderBar(0, 100), '');
  assert.equal(renderBar(100, 100), '████████████████');
  assert.equal(renderBar(200, 100), '████████████████');
  assert.ok(renderBar(50, 100).length < renderBar(100, 100).length);
});

test('renderReport snapshot uses canonical PRISM and renders proxy when one snapshot is absent', () => {
  const windows = computeWindows(new Date('2026-07-15T10:30:00.000Z'));
  const thisWeek = {
    totalSessions: 4,
    totalCostUsd: 10,
    totalInputTokens: 1200,
    totalOutputTokens: 800,
    skillSnapshot: { skill: 80, speedHours: 25, efficiencyTokensPerHour: 75000 },
    pesRubricSnapshot: { idAvg: 3, clAvg: 5, teAvg: 6, acAvg: 7 },
    prismProfile: { compositeScore: 6.5, coaching: [] },
  };
  const lastWeek = {
    totalSessions: 2,
    totalCostUsd: 15,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    skillSnapshot: { skill: 70, speedHours: 20, efficiencyTokensPerHour: 85000 },
    prismProfile: { compositeScore: 6.2 },
  };
  assert.strictEqual(renderReport({ windows, thisWeek, lastWeek }), `Period: 2026-07-06 → 2026-07-15  (this week vs last week, both Mon→Wed, ~2.4d each)

Comparison
                      Last week         This week         Δ
PRISM                 6.4/10 (C+)       7.5/10 (B)        +1.1      ↑
Sessions              2                 4                 +2        ↑
Cost                  $15.00            $10.00            −$5.00    ↓
Tokens                1.5k              2.0k              +500.0    ↑
Skill                 70.0/100          80.0/100          +10.0/100 ↑
Speed                 20.0h             25.0h             +5.0h     ↑
Efficiency            85,000 tok/h      75,000 tok/h      −10,000 tok/h↓
Grade improved C+ → B

What changed most: Cost −$5.00 (win to keep doing).
Focus area: tighten density: cut filler, lead with verb + object, one ask per turn
🚀 Next: Open https://dashboard.optra-prism.com/ for realtime coaching, full PRISM scores, deeper insights, and the LLM-narrated weekly review.`);

  const proxy = renderReport({ windows, thisWeek: { ...thisWeek, skillSnapshot: null }, lastWeek });
  assert.match(proxy, /PRISM \(rubric proxy\)/);
  assert.doesNotMatch(proxy, /^Skill/m);
  assert.match(proxy, /one of these weeks — showing the rubric-average proxy/);
});
