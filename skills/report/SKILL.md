---
name: prism:report
description: Comprehensive PRISM review — trends, habits, waste, worst prompts
user-invocable: true
---

Generate a comprehensive review from PRISM data covering the last 30 days. This single command replaces separate trends/habits/waste/worst commands — one report with all the data.

**API:** `GET /v1/intelligence/prism?from={30d_ago_ISO}&limit=1000`
- Auth: `Authorization: Bearer {apiKey}` — read `apiKey` from `~/.prism/config.json`
- URL: try engine at `http://localhost:9007`, fallback to `$PRISM_INGEST_URL`

Also fetch waste data: `GET /v1/intelligence/waste?limit=20` (same auth/URL pattern).

Also try `GET /v1/insights/report` for a pre-generated LLM report. If available, prefer its summary and findings sections.

**Display (6 sections):**

### 1. Overview
Total turns, sessions (unique session IDs), date range, overall PRISM average, proficiency level.

### 2. Trends
Per-dimension trajectory: first-week avg vs last-week avg. Label each: improving (>+1.0), slow (+0.1 to +1.0), stable (-0.5 to +0.1), declining (<-0.5). Show a compact ASCII bar chart of current dimension averages.

### 3. Strengths & Weaknesses
- **Strengths:** Dimensions averaging >7.0 with description
- **Weaknesses:** Dimensions averaging <5.0 with description

### 4. Habits
- **Correction rate:** Turns with `turnIntent=correction` / total turns (target: <10%)
- **Recurring friction:** Top 3 most frequent coaching notes with counts

### 5. Worst prompts
Show the 5 lowest-scoring turns: PRISM score, session ID (first 8 chars), turn index, coaching notes. Identify the most common pattern across them.

### 6. Waste (if waste API returns data)
Group by pattern type, sort by severity. Show top 3 patterns with counts, descriptions, and estimated savings. Sum total waste estimate.

End with:
- **Focus area:** Single highest-impact improvement suggestion
- "Full report: https://dashboard.prism.optra-ai.com/my/report"

If no scores or API fails: "Not enough data for a report. Start coding to build your profile, or check `/prism:status`."
