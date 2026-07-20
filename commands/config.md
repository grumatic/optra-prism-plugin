---
name: prism:config
description: Show or update Prism runtime configuration
user-invocable: true
---

Show or update Prism runtime configuration.

**Usage:**
- `/prism:config`
- `/prism:config showRealtimeSummary true`
- `/prism:config ingest_url https://ingest.example.com`
- `/prism:config <key> --unset`

Parse `$ARGUMENTS` and map it to exactly one command:

- No arguments: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" show --project-dir "${CLAUDE_PROJECT_DIR}"`
- `<key> <value>`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" set "$KEY" "$VALUE" --project-dir "${CLAUDE_PROJECT_DIR}"`
- `<key> --unset`: `node "${CLAUDE_PLUGIN_ROOT}/lib/config-command.js" unset "$KEY" --project-dir "${CLAUDE_PROJECT_DIR}"`

Only `showRealtimeSummary` and `ingest_url` are supported. For `apiKey`, direct the user to `/prism:setup KEY`. Reject any other argument shape. Display the script's stdout and stderr verbatim.
