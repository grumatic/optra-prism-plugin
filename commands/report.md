---
name: prism:report
description: Weekly review — this week vs last week, PRISM grade, habits, worst prompts
user-invocable: true
---

CLI mirror of the dashboard at https://dashboard.prism.optra-ai.com/. Single command that compares **this week vs last week** for the user's Developer PRISM Score and surfaces habits, wins, worst prompts, and cost.

## Engine endpoints (verified)

The plugin only talks to the ingest gateway. These are the routes used here:

| Route | Method | Purpose | Status |
|-------|--------|---------|--------|
| `/v1/insights/report/quick?from=&to=` | POST | Quick (LLM-free) report scoped to an ISO date range | ✅ live |

> No other ingest route is required. `/v1/prism/scores` (engine-side Layer 3) is **not** proxied through ingest, so per-period sub-scores must come from the quick-report payload's `skillSnapshot` field. Verify with: `curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "x-api-key: $GCK_KEY" "$INGEST/v1/insights/report/quick?from=$FROM&to=$TO"` — expect `200`.

## Scoring (canonical — `prism-scoring-spec.md` §7)

This command renders the **spec-canonical Developer PRISM Score** when the engine has computed Layer 2/3 sub-scores for the requested period:

```
PRISM = 0.50·Skill_10 + 0.30·Efficiency_10 + 0.20·Speed_10        // 0.0–10.0, B = 7.0 baseline
```

Inputs come from `skillSnapshot` (engine pulls from `prism.layer3_scores` + `prism.layer2_metrics`):
- `skill` (0–100) → `Skill_10 = clamp(skill / 10, 0, 10)`
- `speedHours` (focused CLI hours) — input to `Speed_10`
- `efficiencyTokensPerHour` (lower is better) — input to `Efficiency_10`

Asymmetric §7 mapping (mirrors `apps/dashboard/src/lib/prism-score.ts` `asymmetricMap10`):

```
spd_log       = clip(ln(speedHours / target_hours), -1, 1)
Speed_10      = (spd_log >= 0) ? min(7 + 3·spd_log, 10) : max(7 + 7·spd_log, 0)

eff_log       = clip(ln(baseline_tpah / efficiencyTokensPerHour), -1, 1)
Efficiency_10 = (eff_log >= 0) ? min(7 + 3·eff_log, 10) : max(7 + 7·eff_log, 0)
```

**Phase 0 baselines** (per spec §7 → §11):
- `target_hours = 25` per week
- `baseline_tpah = 75_000` tokens / active hour

## Grade mapping (canonical — `apps/dashboard/src/lib/prism-colors.ts` `GRADE_BANDS`)

10-tier ladder on 0.0–10.0. **B = 7.0–7.9 baseline.** Bands are `[from, to)` (last band closed).

| Grade | Range       | Grade | Range       |
|-------|-------------|-------|-------------|
| F     | 0.0 – 3.0   | B     | 7.0 – 8.0   |
| D     | 3.0 – 5.0   | B+    | 8.0 – 8.5   |
| C     | 5.0 – 6.0   | A−    | 8.5 – 9.0   |
| C+    | 6.0 – 6.5   | A     | 9.0 – 9.5   |
| B−    | 6.5 – 7.0   | A+    | 9.5 – 10.0  |

## Flow

1. Compute two ISO date ranges, **day-aligned** so both windows cover the same number of elapsed days:
   - Let `thisWeekStart` = Monday 00:00 UTC of the current ISO week.
   - Let `daysElapsed` = `now − thisWeekStart` (in milliseconds; can be a fractional day count).
   - **This week:** `thisWeekStart` → `now`
   - **Last week (same elapsed window):** `thisWeekStart − 7d` → `thisWeekStart − 7d + daysElapsed`
   - This guarantees both windows have the same length so totals (sessions, cost, tokens) compare apples-to-apples. If today is Wednesday, both windows cover Mon-Tue-Wed-up-to-now-of-day. Never compare a full prior calendar week against a week-to-date current calendar week — that biases the current week downward.
2. Call `quickReport({ from, to })` from `lib/engine.js` once for each window. Two POSTs in parallel; each is 1–5s.
3. For each window, derive a single PRISM score:
   - **Preferred:** when `skillSnapshot` is present → compute canonical PRISM per the formula above.
   - **Fallback:** when `skillSnapshot` is null (Layer 2/3 cadence hasn't run for the period) → use `prismProfile.compositeScore` (rubric average of CL/ID/TE/AC) and **explicitly label the row "PRISM (rubric proxy)"** so the user knows it's not the spec-canonical layered composite.
4. Render the comparison and the rest of the sections from the **this-week** payload only.
5. On any failure: "Couldn't load your report. Try the dashboard: https://dashboard.prism.optra-ai.com/."

## Display

**One metric layer.** Headline = single PRISM number + grade. Don't render the PromptIQ rubric breakdown (CL/ID/TE/AC); it's used silently to pick a coaching tip.

### 1. Header
```
Period: {lastWeekStart} → {thisWeekEnd}  (this week vs last week, both Mon→{day-of-week-now}, {daysElapsed}d each)
```
The day-of-week and elapsed-days disclosure makes the day-aligned comparison explicit. Example: "(this week vs last week, both Mon→Wed, ~3.4d each)".

### 2. Comparison
```
                 Last week           This week           Δ
PRISM            {lwPrism}/10 ({lwGrade})   {twPrism}/10 ({twGrade})   {±delta}  {arrow}
Sessions         {lwSessions}              {twSessions}              {±n}     {arrow}
Cost             ${lwCost}                 ${twCost}                 {±$d}    {arrow}
Tokens           {lwTokens}                {twTokens}                {±n}     {arrow}
```

If `skillSnapshot` is populated for both weeks, also include three sub-score rows so the headline PRISM is auditable:
```
Skill            {lwSkill}/100             {twSkill}/100             {±n}     {arrow}
Speed            {lwSpeed}h                {twSpeed}h                {±n}     {arrow}
Efficiency       {lwTpah} tok/h            {twTpah} tok/h            {±n}     {arrow}
```

If a week's grade crossed a tier boundary, surface a single line below the table (e.g., "Grade improved C → C+", "Grade slipped B → B−"). Otherwise omit.

If `skillSnapshot` is null on either side, label the PRISM row "PRISM (rubric proxy)" and omit the three sub-score rows.

Arrow rules: `↑` improving · `↓` declining · `→` flat. Thresholds: ±0.1 score, ±$1 cost, ±5% tokens/sessions. Direction labels: PRISM up = good · sessions either direction = neutral (just movement) · cost down = good · tokens — context-dependent so just show the arrow.

> **Do not** show first-try rate, friction rate, win rate, or the recurring-friction list — those metrics are no longer tracked here.

### 3. Token usage (this week, with Δ vs last week)

The engine's quick-report payload only exposes `totalInputTokens` / `totalOutputTokens`, not cache reads/writes. Aggregate the cache breakdown client-side from `GET /v1/telemetry/logs` (the `fetchTelemetryLogs` helper in `lib/engine.js`).

**Aggregation procedure** (run for both windows in parallel):
1. Page through `/v1/telemetry/logs?from=<iso>&to=<iso>&limit=1000&offset=N`. Continue while `has_more` is true. Cap at 30 pages (= 30k records) to avoid runaway on huge weeks.
2. For each record where `event_name === 'api_request'`, parse `attributes_json` and sum:
   - `input_tokens` → Input
   - `output_tokens` → Output
   - `cache_read_tokens` → CacheR
   - `cache_creation_tokens` → CacheW
3. Count api_request rows → `turns`. `tokens/turn = total / turns`.
4. `Total = Input + Output + CacheR + CacheW`.

**Render as a horizontal-bar breakdown** (mirrors the Claude Code statusline image style). Bar length proportional to share of `Total`; format numbers with k/M suffixes (1 decimal):

```
Total       105.2M
Input    ▏                  1.0k    Δ +0.0k    →
Output   ▌▌                  284.9k    Δ −41.2k   ↓
CacheR   ████████████████   99.4M    Δ −405.7M  ↓
CacheW   ▎                   5.5M    Δ −25.7M   ↓
                                     {turns}     turns
                                     {tokens/turn} tokens/turn  Δ {±n} {arrow}
```

Bar character: use `▏▎▍▌▋▊▉█` for sub-block resolution; max bar width = 16 chars. The bar represents the row's value as a fraction of the row's max (or of `Total` — pick whatever yields readable comparison; CacheR will dominate for most users, so scale relative to `Total` and clip).

**Direction labels:**
- Total / Input / Output / CacheR / CacheW — context-dependent; just show the arrow (`↑` if up, `↓` if down, `→` if flat). Don't label "good" / "bad" — token usage going up isn't necessarily bad if it tracks more work done.
- `tokens/turn` — **lower is better** (denser prompts = more leverage). `↑` means more tokens spent per turn, label `↓` directionally as "improving".

**Threshold:** ±2% to call a movement non-flat. Below that, render `→`.

If aggregation fails (network, timeout, or 0 api_request events found), skip this section silently.

### 4. Habits (this week)
- **Avg turns/session:** `howYouUseCc.stats.avgTurnsPerSession`
- **Median response:** `howYouUseCc.stats.medianResponseTimeSecs`s
- **Multi-clauding:** if `multiClaudingEvents > 0`, show `{events} events across {sessions} sessions` and suggest closing extra Claude Code windows when working on one problem.

### 5. Worst prompts (this week)
From `worstPrompts[]`, render the 5 lowest by `prismScore` as a table: score, session prefix (8 chars), `turnIndex`, `promptPreview`.

**Render only the table — no derived "Pattern: ..." commentary line.** Don't infer patterns; just show the data the engine returned.

If `worstPrompts[]` is missing or empty, skip the section entirely (don't render the heading).

### 6. Coaching (this week) — only render when there are real tips
Pick the weakest internal dimension silently — the lowest of `pesRubricSnapshot.clAvg` / `idAvg` / `teAvg` / `acAvg`. Look up matching tips in `prismProfile.coaching[]`.

If `prismProfile.coaching[]` is empty (or contains no entry matching the picked dimension), **skip this section entirely** — do not render the heading, do not render a "no coaching tips" placeholder. The end-of-command "Focus area" line already covers what to work on.

When tips ARE present: lead with a one-line focus (e.g., "Tighten prompt density"); render `coaching[].tip` plus `exampleBefore` / `exampleAfter` when those fields exist on the entry.

### 7. Cost optimization (this week) — only render when there's data
**Skip this section entirely** when `costOptimization.totalCostUsd == 0` *or* when both `modelRightsizing[]` and `wasteActions[]` are empty. Don't render a "no data" placeholder.

When data IS present: show `totalCostUsd`, `wastedCostUsd` + `wasteRatio`%, `potentialSavingsUsd`, and the top 3 actions by dollar impact from `modelRightsizing[]` / `wasteActions[]` with their `action` text.

## End with

- **What changed most this week** — pick the metric in section 2 with the largest absolute delta in the bad direction; if all moved good, pick the biggest improvement and label it as the win to keep doing.
- **Focus area** — based on the silently-picked weakest dimension:
  - ID → "tighten density: cut filler, lead with verb + object, one ask per turn"
  - CL → "leverage what's already loaded — name files, reference prior turns instead of re-pasting"
  - TE → "bundle related changes; avoid 'also do X' follow-ups"
  - AC → "kill demonstratives — replace 'fix it' with file:line + error string"
- 🚀 **Next:** "Open https://dashboard.prism.optra-ai.com/ for realtime coaching, full PRISM scores, deeper insights, and the LLM-narrated weekly review."

## Fallbacks

- **Either weekly call fails (HTTP 500 or network):** "Couldn't load this week's data — try the dashboard: https://dashboard.prism.optra-ai.com/."
- **`skillSnapshot` null both weeks:** Render comparison using `prismProfile.compositeScore` labeled "PRISM (rubric proxy)" and add a one-line note: "Layer 2/3 not yet computed for these weeks — showing the rubric-average proxy. Canonical PRISM (per spec §7) will appear once cadence workers populate Skill / Speed / Efficiency."
- **`skillSnapshot` null one week only:** Use rubric proxy on both sides for an apples-to-apples comparison; note the asymmetry in a one-liner.
- **Last-week call returns zero sessions:** Render the table with `—` for last-week values and "no comparison — first week of activity."
