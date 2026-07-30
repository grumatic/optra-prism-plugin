---
name: uninstall
description: Preview or confirm deterministic Prism plugin cleanup
user-invocable: true
disable-model-invocation: true
model: haiku
allowed-tools:
  - Agent(prism:prism-uninstall)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/uninstall.js" preview --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plugin-root "${CLAUDE_PLUGIN_ROOT}")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/uninstall.js" apply --confirm * --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plugin-root "${CLAUDE_PLUGIN_ROOT}")
---

Use the `prism:prism-uninstall` Agent exactly once in the foreground. Delegate
the complete execution contract and fully expanded argument string below.

**Usage:**
- `/prism:uninstall`
- `/prism:uninstall confirm <plan-token>`

Map the fully expanded `$ARGUMENTS` string only when it has one of these exact
shapes:

- Exact `confirm ` followed by one lowercase 64-character hexadecimal token
  matching `^confirm ([0-9a-f]{64})$`: `node "${CLAUDE_PLUGIN_ROOT}/lib/uninstall.js" apply --confirm "<the captured 64-character token>" --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plugin-root "${CLAUDE_PLUGIN_ROOT}"`
- No arguments: `node "${CLAUDE_PLUGIN_ROOT}/lib/uninstall.js" preview --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plugin-root "${CLAUDE_PLUGIN_ROOT}"`

Reject every other argument shape without running Bash and respond exactly:
`Usage: /prism:uninstall [confirm <plan-token>]`

For either valid shape, run the selected command exactly once. Do not run any
other command, inspect files directly, or ask a question. The script owns target
validation, confirmation, cleanup, and rendering.

Do not call Bash or any other tool yourself. After the Agent returns, make your
final response exactly the first text content block in the Agent result. Ignore
the continuation `agentId` and usage metadata that Claude Code appends. Do not
summarize, explain, label, wrap, or add commentary.
