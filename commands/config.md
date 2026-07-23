---
name: prism:config
description: Show or update Prism runtime configuration
user-invocable: true
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

Parse `$ARGUMENTS` and map it to exactly one command:

- No arguments: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}"`
- `show`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}"`
- `help` or `--help`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" help --project-dir "${CLAUDE_PROJECT_DIR}"`
- `set <field> <value>`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" set "$FIELD" "$VALUE" --project-dir "${CLAUDE_PROJECT_DIR}"`
- `unset <field>`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" unset "$FIELD" --project-dir "${CLAUDE_PROJECT_DIR}"`

Do not validate or rewrite field names or values in the command prompt; the script is the authority. Reject any other argument shape. Display the script's stdout and stderr verbatim.
