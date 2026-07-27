---
name: prism:status
description: Show Prism connection status and session information
user-invocable: true
disable-model-invocation: true
context: fork
background: false
agent: prism:prism-output
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/status.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/status.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true`

Return only the complete inline command output above, reproduced verbatim and
character-for-character. Do not summarize, explain, label, or add commentary.
