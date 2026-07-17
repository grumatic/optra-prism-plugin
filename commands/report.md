---
name: prism:report
description: Weekly review — this week vs last week, PRISM grade, habits, worst prompts
user-invocable: true
allowed-tools: Bash(node:*)
---

Weekly Prism review:

!`node "${CLAUDE_PLUGIN_ROOT}/lib/report.js"`

Display the output above verbatim.
