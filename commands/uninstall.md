---
name: prism:uninstall
description: Uninstall the Prism plugin — remove config, OTEL settings, and plugin registration
user-invocable: true
---

Uninstall the Prism plugin and clean up all configuration.

**Usage:** `/prism:uninstall`

**Steps:**

1. Confirm with the user: "This will remove the Prism plugin, API key, and OTEL telemetry settings (from both user and project scopes). Continue? (yes/no)"

2. Only proceed if the user confirms. Then run cleanup using the Bash tool:

3. Locate the plugin root and remove OTEL env vars from **both** scopes (user + project-local):
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
   if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/lib/settings.js" ]; then
     for p in "$HOME/.claude/plugins/cache/optra-prism/prism"/*/; do
       if [ -f "$p/lib/settings.js" ]; then PLUGIN_ROOT="${p%/}"; break; fi
     done
   fi
   if [ -z "$PLUGIN_ROOT" ] && [ -f "$HOME/.prism/claude-code-plugin/lib/settings.js" ]; then
     PLUGIN_ROOT="$HOME/.prism/claude-code-plugin"
   fi
   if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/lib/settings.js" ]; then
     node "$PLUGIN_ROOT/lib/settings.js" remove --scope both --project-dir "$CLAUDE_PROJECT_DIR"
   else
     echo "Plugin root not found — manually remove OTEL keys from ~/.claude/settings.json and <project>/.claude/settings.local.json"
   fi
   ```

4. Remove the Prism user config, plugin data dir, plugin cache (all versions), and any cloned marketplace dir. Globs catch every cached version and any owner-prefixed marketplace clone:
   ```bash
   rm -rf ~/.prism
   rm -rf "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/prism-optra-prism}"
   rm -rf ~/.claude/plugins/cache/optra-prism ~/.claude/plugins/cache/optra-prism-*
   rm -rf ~/.claude/plugins/marketplaces/optra-prism ~/.claude/plugins/marketplaces/*/optra-prism-plugin 2>/dev/null || true
   ```

5. Unregister the marketplace (this *should* update `installed_plugins.json` and `known_marketplaces.json`):
   ```bash
   claude plugin marketplace remove grumatic/optra-prism-plugin 2>/dev/null || true
   ```

6. Belt-and-braces: explicitly prune the plugin/marketplace entries from the JSON registries so a stale entry can't keep the plugin alive after restart:
   ```bash
   if command -v node &>/dev/null; then
     for f in "$HOME/.claude/plugins/installed_plugins.json" "$HOME/.claude/plugins/known_marketplaces.json"; do
       [ -f "$f" ] || continue
       node - "$f" <<'NODE' 2>/dev/null || true
   const fs = require('fs');
   const path = process.argv[2];
   const data = JSON.parse(fs.readFileSync(path, 'utf8'));
   let changed = false;
   if (data && data.plugins && data.plugins['prism@optra-prism']) {
     delete data.plugins['prism@optra-prism']; changed = true;
   }
   if (data && data['optra-prism']) {
     delete data['optra-prism']; changed = true;
   }
   if (changed) fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
   NODE
     done
   fi
   ```

7. Confirm: "Prism plugin uninstalled (cleared from user + project-local scopes, all caches purged). **Restart Claude Code** to complete removal."

   If project-scope was ever used in other repos, add: "Note: project-scope OTEL vars in *other* repos' `.claude/settings.local.json` were not touched — re-run `/prism:uninstall` from inside each repo (or delete the OTEL_* keys manually)."
