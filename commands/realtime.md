---
name: realtime
description: Show the current session's realtime Prism score summary (grade, cost, turns)
user-invocable: true
disable-model-invocation: true
model: haiku
allowed-tools:
  - Agent(prism:prism-output)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}")
  - PowerShell(node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}")
---

Use the `prism:prism-output` Agent exactly once in the foreground. Delegate this
exact task:

Run exactly one command, with the Bash tool or, when Bash is unavailable, with
the PowerShell tool:
`node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --data-dir "${CLAUDE_PLUGIN_DATA}"`

Return only its complete tool-result text, reproduced verbatim and
character-for-character.

Do not call Bash, PowerShell, or any other tool yourself. After the Agent
returns, make your final response exactly the first text content block in the
Agent result. Ignore the continuation `agentId` and usage metadata that Claude
Code appends. Do not summarize, explain, label, wrap, or add commentary.
