---
name: doctor
description: Diagnose Prism plugin configuration and connectivity issues
user-invocable: true
disable-model-invocation: true
model: haiku
allowed-tools:
  - Agent(prism:prism-output)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true)
---

Use the `prism:prism-output` Agent exactly once in the foreground. Delegate this
exact task:

Run exactly one Bash command:
`node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" 2>&1 || true`

Return only its complete Bash tool-result text, reproduced verbatim and
character-for-character.

Do not call Bash or any other tool yourself. After the Agent returns, make your
final response exactly the first text content block in the Agent result. Ignore
the continuation `agentId` and usage metadata that Claude Code appends. Do not
summarize, explain, label, wrap, or add commentary.
