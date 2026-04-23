---
name: prism:cost
description: Show current session cost, tokens, and model mix
user-invocable: true
---

Show the user a summary of the **current session**. Data lives entirely on-disk — read `${CLAUDE_PLUGIN_DATA}/session-state.json`. No network call.

## Fields in session-state.json

The stop-handler hook writes these after each turn (see `hooks/scripts/stop-handler.js`):

- `turnCount` — turns since session start (reset on `/compact`)
- `sessionStart` — epoch ms
- `totalInputTokens` / `totalOutputTokens` — cumulative, this session
- `totalCost` — cumulative USD, computed from `MODEL_PRICING` table in stop-handler
- `modelCounts` — `{ "<model-id>": <turns> }`
- `responseTimes` — last 50 response durations (ms)
- `firstTurnInputTokens` / `lastTurnInputTokens` — for context-growth ratio
- `opusLowOutputCount` — turns on Opus with trivial output (rightsizing signal)

## Display

### 1. Headline (one line)
`{turnCount} turns · {duration} · ${totalCost} · {totalInputTokens + totalOutputTokens} tokens`

- `duration` = `now - sessionStart`, formatted `Hh Mm` (drop hours if zero).
- Format cost to 2 decimals, fall back to `—` if `totalCost` is missing.
- Token count: thousands separator (`123,456`).

### 2. Model mix
If `modelCounts` has more than one entry, show a compact breakdown:
`opus 12 · sonnet 4 · haiku 1` (model → last path segment, lowercased, without `claude-` prefix; percentages in parens if useful).

### 3. Signals & tips
Pick 2–4 based on what the numbers show. Plain language, no jargon.

- **Context growth** — if `firstTurnInputTokens > 0` and `lastTurnInputTokens / firstTurnInputTokens > 3`, say: "Context grew {ratio}× since turn 1 — run `/compact` to free it, or `/clear` if you're switching work."
- **High turn count** — if `turnCount > 20`, suggest `/compact`. If `> 80`, recommend `/clear`.
- **Opus on easy work** — if `opusLowOutputCount >= 3`, say: "Opus ran on {count} low-output turns — try `/model sonnet` when the change is small or the answer is short."
- **Slow responses** — if the median of `responseTimes` > 60s, mention it ("Median response ~{n}s — latency is a Skill headwind (RLR).") and suggest keeping prompts scoped.
- **No pressure** — if none of the above fire and turn count is modest (< 10), just confirm all is healthy.

### 4. Pointer
End with: "Full per-session cost, token, and model breakdown: https://dashboard.prism.optra-ai.com/my/report"

## Fallbacks

- File missing or unreadable: "No session data yet — stats appear after the first response."
- File present but `totalCost` unset (missing pricing for the active model): show tokens + turn count + duration only, and note "Cost pending — pricing table doesn't know this model yet."
