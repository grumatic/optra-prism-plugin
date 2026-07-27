---
name: prism:help
description: Show all available Prism plugin commands and how to use them
user-invocable: true
disable-model-invocation: true
context: fork
background: false
agent: prism:prism-output
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" 2>&1 || true)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" 2>&1 || true`

Return only the complete inline command output above, reproduced verbatim and
character-for-character. Do not summarize, explain, label, or add commentary.
