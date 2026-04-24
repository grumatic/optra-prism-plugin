---
name: prism:score
description: PRISM Skill score — weakest component, coaching tips, and optimization advice
user-invocable: true
---

Show the user's **Skill** score (the coachable one), break down its 5 components, and coach the weakest.

## Show Skill profile + coaching

**API:** `GET /v1/insights/report` (via the ingest proxy — resolved from config).
- Auth header: `x-api-key: <gck_* key>` (read from `~/.prism/config.json`).
- URL: use `$PRISM_INGEST_URL` if set, otherwise the cached ingest URL, otherwise `https://ingest.prism.optra-ai.com`.
- Use the helper in `lib/engine.js` (`fetchReport()`); it handles auth and error reasons.

### Payload fields we read

Everything comes from the top-level `skillSnapshot` (primary) with `prismProfile.coaching[]` and `pesRubricSnapshot` as supporting context.

```
{
  "skillSnapshot": {
    "skill": 62.4,              // 0–100 composite
    "skillTier": "proficient",  // novice | practitioner | proficient | expert | elite
    "speedHours": 4.8,          // focused CLI hours in the period
    "efficiencyTokensPerHour": 82000,
    "sse": 6.1,                 // Sub-Session Efficiency (0–10)
    "pes": 5.2,                 // Prompt Efficiency (0–10)
    "ie":  6.7,                 // Iteration Efficiency (0–10)
    "crr": 7.0,                 // Context Reset Rate (0–10)
    "fc":  5.9                  // Flow Continuity (0–10)
  },
  "pesRubricSnapshot": { "clAvg": ..., "idAvg": ..., "teAvg": ..., "acAvg": ... },
  "prismProfile": {
    "coaching": [ { "dimension": "id", "label": "Information Density", "coaching": [ { "tip": "...", "exampleBefore": "...", "exampleAfter": "..." } ] } ]
  }
}
```

Skill is a fixed, weighted composite: `100 × (0.45·SSE + 0.20·PES + 0.15·IE + 0.10·CRR + 0.10·FC)`, all five inputs on a 0–10 scale.

## Display (4 sections)

### 1. Headline
`Skill {skill}/100 — {skillTier}`. One short line. Include the tier word as-is.

### 2. Component breakdown
List the 5 Skill components sorted low→high with a tiny bar (█/░, scale 0–10) and the weight in parentheses so the user sees which ones move the composite most:

```
SSE 6.1/10 (45%)  ██████░░░░
PES 5.2/10 (20%)  █████░░░░░
IE  6.7/10 (15%)  ███████░░░
CRR 7.0/10 (10%)  ███████░░░
FC  5.9/10 (10%)  ██████░░░░
```

Use the full labels once in a legend line above the bars:
`SSE = Sub-Session Efficiency · PES = Prompt Efficiency · IE = Iteration Efficiency · CRR = Context Reset Rate · FC = Flow Continuity`

Mark the **weakest** (lowest score) and the **biggest drag on your Skill score** (the component whose `(10 − score) × weight` is largest — it's pulling the composite down the most). They're often the same; if not, call out both.

### 3. Weakest-component coaching
Pick the component with the lowest score. Give 2–3 concrete coaching tips:

- **PES low** — prefer tips from `prismProfile.coaching[]` entries whose `dimension` is one of `cl`, `id`, `te`, `ac` (the 4 PromptIQ rubric dims — they roll up into PES). If `pesRubricSnapshot` is present, call out the weakest rubric dim (lowest of `clAvg/idAvg/teAvg/acAvg`) by name. Include `exampleBefore` / `exampleAfter` when available.
- **SSE low** — sub-session outcomes are poor. Suggest: break work into smaller sub-sessions, state the done-criteria upfront, close the loop (commit / test) before switching goals.
- **IE low** — too many correction turns. Suggest: give constraints upfront (paths, function names, expected output format), avoid "now also do X" turns that reopen scope.
- **CRR low** — too many `/clear` or fresh sessions mid-task. Suggest: use `/compact` to keep context, only `/clear` when switching work domains.
- **FC low** — flow broken by long gaps or context churn. Suggest: batch related tasks, keep sessions under ~90 min of active work, avoid interleaving unrelated projects.

Also call out the strongest component (highest score) as a keep-doing.

### 4. Optimization advice
2–3 concrete tips keyed off the numbers:

- `efficiencyTokensPerHour` high (> ~150k) → tokens are growing fast. "Run `/compact` every 2–3 tasks; use `.claudeignore` to keep the file tree lean; try `/model sonnet` for simple edits."
- `speedHours` < 2 for a weekly report → not enough active time for stable scoring; mention "scores tighten as you cross ~100 completed sub-sessions."
- Any component < 4 → flag it as the top coaching target; everything else waits.

End with: `Detailed trends and history: https://dashboard.prism.optra-ai.com/my/report`

## Fallbacks

- `skillSnapshot` missing from the payload (older report, or cold-start period with no Layer 2/3 rows yet): fall back to `prismProfile.dimensions[]` — these are the 4 PromptIQ rubric dims (CL/ID/TE/AC). Show them as a PES-only view with the caveat "Skill composite not available for this period — showing Prompt Efficiency rubric only."
- `reason: "http_error"` with `status: 404` → "No report yet. Generate one on the dashboard (https://dashboard.prism.optra-ai.com/my/report) or ask me to run `/prism:report` — it will trigger generation."
- Any other error → "Couldn't fetch your profile. Check `/prism:status`."
