---
name: prism:realtime
description: Show the current session's realtime Prism score summary (grade, cost, turns)
user-invocable: true
disable-model-invocation: true
context: fork
background: false
agent: prism:prism-output
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}")
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}"`

Return only the complete inline command output above, reproduced verbatim and
character-for-character. Do not summarize, explain, label, or add commentary.
