---
name: prism:doctor
description: Diagnose Prism plugin configuration and connectivity issues
user-invocable: true
disable-model-invocation: true
context: fork
background: false
agent: prism:prism-output
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" 2>&1 || true)
---

!`node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" 2>&1 || true`

Return only the complete inline command output above, reproduced verbatim and
character-for-character. Do not summarize, explain, label, or add commentary.
