---
name: prism:report
description: Weekly review — this week vs last week, PRISM grade, habits, worst prompts
user-invocable: true
disable-model-invocation: true
context: fork
background: false
agent: prism:prism-output
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/report.js" 2>&1 || true)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/report.js" 2>&1 || true`

Return only the complete inline command output above, reproduced verbatim and
character-for-character. Do not summarize, explain, label, or add commentary.
