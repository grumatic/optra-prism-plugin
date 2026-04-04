---
name: prism:score
description: PRISM score — weakest dimension, coaching, and optimization tips
user-invocable: true
---

Show the user's PRISM profile: weakest dimension with coaching, dimension bar chart, and optimization tips. If the user passes a prompt to score, score it instead.

## If the user wants to score a specific prompt

Offer to score their most recent prompt or any prompt they paste in using the PRISM criteria below. Provide specific, actionable feedback on how to improve each dimension.

## Otherwise: show PRISM profile + coaching

**API:** `GET /v1/intelligence/prism?from={7d_ago_ISO}&limit=200`
- Auth: `Authorization: Bearer {apiKey}` — read `apiKey` from `~/.prism/config.json`
- URL: try engine at `http://localhost:9007`, fallback to `$PRISM_INGEST_URL`

**Compute:** Average each dimension across all turns:
- PQ=(pqSpecificity+pqDecomposition)/2, IE=(ieConvergence+ieRecovery)/2, VD=(vdReview+vdValidation)/2
- CQ=(cqJudgment+cqSafety)/2, TU=(tuSelection+tuContext)/2, AF=(afDelegation+afConfiguration)/2

**Display (4 sections):**

### 1. Weakest dimension
Show the weakest dimension with its two sub-scores, 3 coaching tips specific to that dimension (with good/bad examples), and highlight the strongest dimension.

### 2. Bar chart
Horizontal bar chart (█/░) of all 6 dimensions sorted low→high, marking weakest and strongest.

### 3. Optimization tips
Include 2-3 actionable tips based on the user's profile:
- If PQ < 5: "Reference exact file paths, function names, or line numbers in every prompt"
- If VD < 5: "Read target files before editing — Read tool, not cat via Bash"
- If TU < 5: "Run `/compact` every 2-3 tasks, `/clear` when switching work"
- If IE < 5: "Add constraints upfront to avoid correction turns"
- General: model selection (`/model sonnet` for simple tasks), context management (`.claudeignore`), LSP plugins for fewer file reads

### 4. Dimension reference
Briefly list all 6 dimensions with weights:
1. **Prompt Quality (PQ) — 25%** — Specificity + Decomposition
2. **Iteration Efficiency (IE) — 20%** — Convergence + Recovery
3. **Verification Discipline (VD) — 20%** — Review + Validation
4. **Code Quality (CQ) — 15%** — Judgment + Safety
5. **Tool Use (TU) — 10%** — Selection + Context
6. **Advanced Features (AF) — 10%** — Delegation + Configuration

Scale: 9.0+=Elite, 7.0-8.9=Expert, 5.0-6.9=Proficient, 3.0-4.9=Practitioner, <3.0=Novice

End with: "Detailed trends and history: https://dashboard.prism.optra-ai.com/prism"

If no scores or API fails: "No PRISM scores yet. Start coding to build your profile, or check `/prism:status`."
