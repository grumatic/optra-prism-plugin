---
description: Uninstall the Prism plugin — remove config, OTEL settings, and plugin registration
user-invocable: true
---

Uninstall the Prism plugin and clean up all configuration.

**Usage:** `/prism:uninstall`

**Steps:**

1. Confirm with the user: "This will remove the Prism plugin, API key, and OTEL telemetry settings. Continue? (yes/no)"

2. Only proceed if the user confirms. Then run cleanup using the Bash tool:

3. Locate the plugin root and remove OTEL env vars from `~/.claude/settings.json`:
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
   for p in "$PLUGIN_ROOT" "$HOME/projects/optra/optra-prism/apps/plugin" "$HOME/.prism/claude-code-plugin"; do
     if [ -f "$p/lib/settings.js" ]; then PLUGIN_ROOT="$p"; break; fi
   done
   if [ -n "$PLUGIN_ROOT" ]; then
     node "$PLUGIN_ROOT/lib/settings.js" remove
   else
     echo "Plugin root not found — manually remove OTEL keys from ~/.claude/settings.json"
   fi
   ```

4. Remove the Prism config directory:
   ```bash
   rm -rf ~/.prism
   ```

5. Confirm: "Prism plugin uninstalled. **Restart Claude Code** to stop OTEL telemetry."
   Note: No need to unregister from Claude Code — the `--plugin-dir` flag is only active for the session it was passed in.
