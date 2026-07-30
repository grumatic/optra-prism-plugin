---
name: help
description: (prism) Show all available Prism plugin commands and how to use them
user-invocable: true
disable-model-invocation: true
model: haiku
allowed-tools:
  - Agent(prism:prism-output)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" 2>&1 || true)
---

Use the `prism:prism-output` Agent exactly once in the foreground. Delegate this
exact task:

Run exactly one Bash command:
`node "${CLAUDE_PLUGIN_ROOT}/lib/help.js" 2>&1 || true`

Return only its complete Bash tool-result text, reproduced verbatim and
character-for-character.

Do not call Bash or any other tool yourself. After the Agent returns, make your
final response exactly the first text content block in the Agent result. Ignore
the continuation `agentId` and usage metadata that Claude Code appends. Do not
summarize, explain, label, wrap, or add commentary.
