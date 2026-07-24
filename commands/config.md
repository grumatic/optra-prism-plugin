---
name: prism:config
description: Show or update Prism runtime configuration
user-invocable: true
disable-model-invocation: true
context: fork
background: false
agent: prism:prism-config
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" help --project-dir "${CLAUDE_PROJECT_DIR}")
---

Show or update Prism runtime configuration.

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

Do not validate or rewrite field names or values in the command prompt; the script is the authority. Reject any other argument shape. The final response must be only the complete Bash tool-result text, reproduced verbatim and character-for-character.
