---
name: config
description: Show or update Prism runtime configuration
user-invocable: true
disable-model-invocation: true
model: haiku
allowed-tools:
  - Agent(prism:prism-config)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" help --project-dir "${CLAUDE_PROJECT_DIR}")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" set * --project-dir "${CLAUDE_PROJECT_DIR}")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" unset * --project-dir "${CLAUDE_PROJECT_DIR}")
---

Use the `prism:prism-config` Agent exactly once in the foreground. Delegate the
complete execution contract and fully expanded argument string below.

**Usage:**
- `/prism:config`
- `/prism:config show`
- `/prism:config help`
- `/prism:config --help`
- `/prism:config set show_realtime_summary true`
- `/prism:config set ingest_url https://ingest.example.com`
- `/prism:config unset <field>`

The fully expanded argument string is `$ARGUMENTS`. Map it to exactly one command:

- No arguments: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}"`
- `show`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}"`
- `help` or `--help`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" help --project-dir "${CLAUDE_PROJECT_DIR}"`
- `set <field> <value>`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" set "$FIELD" "$VALUE" --project-dir "${CLAUDE_PROJECT_DIR}"`
- `unset <field>`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" unset "$FIELD" --project-dir "${CLAUDE_PROJECT_DIR}"`

An empty argument string is a complete request and selects the "No arguments"
mapping. Run the selected command immediately; do not ask a question or list
the available commands.

Do not validate or rewrite field names or values in the command prompt; the
script is the authority. Reject any other argument shape.

Do not call Bash or any other tool yourself. After the Agent returns, make your
final response exactly the first text content block in the Agent result. Ignore
the continuation `agentId` and usage metadata that Claude Code appends. Do not
summarize, explain, label, wrap, or add commentary.
