---
name: prism:uninstall
description: Uninstall the Prism plugin — remove config, OTEL settings, and plugin registration
user-invocable: true
---

Uninstall the Prism plugin and clean up all configuration.

**Usage:** `/prism:uninstall`

**Steps:**

1. Confirm with the user: "This will remove the Prism plugin, API key, and OTEL telemetry settings from **all scopes** (user, project, and project-local) in this repo. Continue? (yes/no)"

2. Only proceed if the user confirms. Then run cleanup using the Bash tool.

3. Locate the plugin root and remove OTEL env vars from **all three settings files** for the current project:
   - `~/.claude/settings.json` (user scope)
   - `$CLAUDE_PROJECT_DIR/.claude/settings.json` (project-shared, committed)
   - `$CLAUDE_PROJECT_DIR/.claude/settings.local.json` (project-local, gitignored)

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
     node "$PLUGIN_ROOT/lib/settings.js" remove --scope all --project-dir "$CLAUDE_PROJECT_DIR"
     node "$PLUGIN_ROOT/lib/settings.js" cleanup-registries
   else
     echo "Plugin root not found — manually remove OTEL keys from:"
     echo "  ~/.claude/settings.json"
     echo "  $CLAUDE_PROJECT_DIR/.claude/settings.json"
     echo "  $CLAUDE_PROJECT_DIR/.claude/settings.local.json"
   fi
   ```

4. Remove plugin data and cache (`~/.prism` is handled by step 3's `cleanup-registries` — only deleted when no other scopes remain):
   ```bash
   rm -rf "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/prism-optra-prism}"
   rm -rf ~/.claude/plugins/cache/optra-prism ~/.claude/plugins/cache/optra-prism-*
   ```

5. Belt-and-braces: prune plugin entries from registries in case plugin root was not found in step 3:
   ```bash
   node -e '
   var fs=require("fs"),p=require("path"),h=require("os").homedir();
   [p.join(h,".claude/plugins/installed_plugins.json"),
    p.join(h,".claude/settings.json")].forEach(function(f){
     try{var d=JSON.parse(fs.readFileSync(f,"utf8")),c=false;
     if(d.plugins&&d.plugins["prism@optra-prism"]){delete d.plugins["prism@optra-prism"];c=true}
     if(d.enabledPlugins&&d.enabledPlugins["prism@optra-prism"]){delete d.enabledPlugins["prism@optra-prism"];c=true}
     if(c)fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n")}catch{}})
   ' 2>/dev/null || true
   ```

6. Confirm: "Prism plugin uninstalled for this scope. OTEL env vars and enabledPlugins cleaned; caches purged. **Restart Claude Code** to complete removal."

   If step 3's `cleanup-registries` reported remaining installs in other scopes, add:
   "Note: The plugin is still installed in other projects/scopes: [list from cleanup-registries output]. Run `/prism:uninstall` from those projects to remove."

   Always add: "The marketplace registration (`optra-prism`) is preserved — remove it separately with `claude plugin marketplace remove optra-prism` if desired."

7. End with this call-to-action (verbatim):
   > 👋 Your data is still on the dashboard at https://dashboard.prism.optra-ai.com/ — sign in any time to review past PRISM scores, insights, and coaching history. Reinstall with `/plugin install prism` whenever you want realtime coaching back.
