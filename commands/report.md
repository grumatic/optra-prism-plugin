---
name: prism:report
description: Comprehensive review — Skill profile, habits, worst prompts, cost
user-invocable: true
---

Generate a fresh **quick** PRISM report and display it in the terminal. This is a structured, LLM-free snapshot sized for CLI viewing — it is NOT the same as the full narrative dashboard report at `https://dashboard.prism.optra-ai.com/my/report`.

**Flow:**
1. Call `quickReport()` from `lib/engine.js` (POST `/v1/insights/report/quick`). Synchronous, typical latency 1–5s. Tell the user it's computing.
2. Render the sections below directly from the returned payload.
3. On failure, point them at the dashboard link for the full narrative version.

**Auth / URL:** `x-api-key: <gck_* key>` from `~/.prism/config.json`; URL from `$PRISM_INGEST_URL`, the cached ingest URL, or `https://ingest.prism.optra-ai.com`. `quickReport()` handles this.

> For the full LLM-narrated report (chapters, coaching prose, up to ~120s), open the dashboard — the plugin does not trigger that path.

**Payload shape:** see `apps/prism-engine/src/insights/types.rs`. Top-level keys we read:
`meta`, `skillSnapshot`, `skillTrend`, `sseSeries`, `metricSparklines`, `pesRubricSnapshot`, `prismProfile`, `atAGlance`, `activity`, `howYouUseCc`, `impressiveThings`, `whereThingsGoWrong`, `costOptimization`, `worstPrompts`, `trends`, `charts`.

## Display (7 sections)

### 1. Overview
From `meta`: `periodStart` → `periodEnd`, `totalSessions`, `totalMessages`, `activeDays`.
From `skillSnapshot` (headline row — all three numbers on one line):
`Skill {skill}/100 ({skillTier}) · Speed {speedHours}h · Efficiency {efficiencyTokensPerHour} tokens/hr`

### 2. Skill breakdown
List the 5 Skill components from `skillSnapshot` sorted low→high, each with a tiny bar (█/░, 0–10) and weight. Legend line above:
`SSE = Sub-Session Efficiency · PES = Prompt Efficiency · IE = Iteration Efficiency · CRR = Context Reset Rate · FC = Flow Continuity`

```
SSE 6.1/10 (45%)  ██████░░░░
PES 5.2/10 (20%)  █████░░░░░
...
```

Call out the **weakest** component and, if different, the **biggest drag on your Skill score** (largest `(10 − score) × weight`).

If `pesRubricSnapshot` is present and PES is the weakest Skill component, show which of the 4 PromptIQ rubric dimensions is dragging PES down — pick the lowest of `clAvg` / `idAvg` / `teAvg` / `acAvg` and name it (Context Leverage / Information Density / Turn Economy / Ambiguity Cost).

### 3. Trends
Two sub-parts:

- **Skill trend** — if `skillTrend[]` has length ≥ 2, show first vs last `skill` delta and the tier transition (e.g. `practitioner → proficient`). Label direction: improving / flat / declining.
- **Other signals** — if `trends.points[]` has length ≥ 2, show first-vs-last deltas for `firstTryRate`, `frictionRate`, `costUsd`. Same direction label.
- **Component trajectory** — if `metricSparklines` is present, for each of IE / CRR / FC / RLR / QR show a one-line sparkline from `value[]` using Unicode blocks (`▁▂▃▄▅▆▇█`). Skip any series that is empty or has a single point.

### 4. Habits
- **First-try rate** — `howYouUseCc.stats.firstTryRate` (target: >70%).
- **Avg turns per session** — `howYouUseCc.stats.avgTurnsPerSession` (target: low is better).
- **Multi-clauding** — if `howYouUseCc.stats.multiClaudingEvents > 0`, mention count and session share. Suggest closing extra Claude Code windows when working on one problem.
- **Recurring friction** — from `whereThingsGoWrong.categories[]`, top 3 by `count`, each with `label` and `mitigation`.

### 5. Wins
From `impressiveThings`: `winRate` (as %), `totalWinSessions`, and the top 3 from `highlights[]` (each with `label` and `sessionCount`). Skip this section if `totalWinSessions == 0`.

### 6. Worst prompts
From `worstPrompts[]` (if present), show the 5 lowest-scoring turns: `prismScore`, `sessionId` (first 8 chars), `turnIndex`, `promptPreview`. Call out the common pattern if one is visible (e.g. all are vague "fix this" prompts, all lack file paths, all chained multiple goals in one turn).

### 7. Cost optimization
From `costOptimization`: `totalCostUsd`, `wastedCostUsd` (and `wasteRatio` as %), `potentialSavingsUsd`. If `modelRightsizing[]` or `wasteActions[]` are non-empty, show the top 3 (ranked by `savingsUsd` / `wastedCostUsd`), each with its `action` text and the dollar amount.

## End with

- **Focus area** — single highest-impact item. Prefer `atAGlance.quickWins[]` (first entry's `label`); otherwise derive from the weakest Skill component using the same mapping as `/prism:score`:
  - PES → "tighten prompts: reference file paths, name constraints, state done-criteria"
  - SSE → "narrow sub-session goals and close the loop (test/commit) before switching"
  - IE → "state constraints upfront — fewer 'also do X' correction turns"
  - CRR → "prefer `/compact` over `/clear`; only reset when switching domains"
  - FC → "batch related work; keep sessions under ~90 min of active effort"
- "Full report: https://dashboard.prism.optra-ai.com/my/report"

## Fallbacks

- `skillSnapshot` missing (report generated before the v2.14 payload extension, or a cold-start period): headline falls back to `prismProfile.compositeScore / proficiencyLevel` on a 0–10 scale with a caveat line "Skill composite not available for this period — showing the Prompt Efficiency rubric average instead." The Skill breakdown section becomes a PromptIQ rubric view using `prismProfile.dimensions[]` (CL/ID/TE/AC).
- `atAGlance.quickWins[]` empty → skip the "Focus area" quickWin lookup and go straight to the Skill-component mapping.
- `quickReport()` fails → "Couldn't generate a quick report. Try the full dashboard report: https://dashboard.prism.optra-ai.com/my/report."
- Any other error → "Couldn't load your report. Check `/prism:status`."
