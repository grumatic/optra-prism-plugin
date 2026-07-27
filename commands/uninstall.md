---
name: prism:uninstall
description: Preview or confirm deterministic Prism plugin cleanup
user-invocable: true
disable-model-invocation: true
context: fork
background: false
agent: prism:prism-uninstall
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/uninstall.js" preview --project-dir "${CLAUDE_PROJECT_DIR}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plugin-root "${CLAUDE_PLUGIN_ROOT}")
---

Preview or confirm Prism plugin cleanup.

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
validation, confirmation, cleanup, and rendering. After Bash returns, the final
response must be only the complete Bash tool-result text, reproduced verbatim
and character-for-character.
