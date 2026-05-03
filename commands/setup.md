---
name: prism:setup
description: Configure the Prism plugin with your gck_* API key
user-invocable: true
---

Configure the Prism plugin with a `gck_*` API key.

**Usage:**
- `/prism:setup gck_YOUR_KEY` — default scope (keeps current scope if already set up; else user).
- `/prism:setup gck_YOUR_KEY --user` — activate for every project (writes to `~/.claude/settings.json`).
- `/prism:setup gck_YOUR_KEY --project` — activate only in this project (writes to `$CLAUDE_PROJECT_DIR/.claude/settings.local.json`, auto-gitignored).

No API key? Get one at: https://dashboard.prism.optra-ai.com/setup

**Scope rules:**
- OTEL env vars (including the gck_* secret) live in exactly one scope at a time.
- We **never** write to `$CLAUDE_PROJECT_DIR/.claude/settings.json` (shared, committed) because the gck_* key embeds in `OTEL_EXPORTER_OTLP_HEADERS`.
- Switching scopes moves the vars (does not duplicate).

**Steps:**

1. Read existing config from `~/.prism/config.json` (if it exists). If a key already exists and no new key was provided, show the prefix (e.g., `gck_abc12...`) and ask if they want to replace it.

2. Validate the key starts with `gck_`. If not: "Usage: `/prism:setup gck_YOUR_KEY [--user|--project]`"

3. Write the plugin config (preserve existing `prismThreshold`, default to 4). Wipe the stale config cache so step 4 fetches fresh URLs for the (possibly new) key:
   ```bash
   mkdir -p ~/.prism && chmod 700 ~/.prism
   rm -f ~/.prism/config-cache.json
   ```
   Write JSON to `~/.prism/config.json` with: `apiKey`, `prismThreshold` (preserved or 4), `enableGateway: false`. Then `chmod 600 ~/.prism/config.json`.

4. Fetch the latest service URLs and guarantee `~/.prism/config-cache.json` exists (writes production fallback URLs if the endpoint is unreachable):
   ```bash
   node -e "
     const c = require('$PLUGIN_DIR/lib/config');
     c.ensureCache('$API_KEY').then(r => {
       console.log('Config cached (' + r.source + '): ' + r.ingest_url);
       if (r._changed && r._changed.length > 0) {
         console.log('URLs updated:');
         r._changed.forEach(ch => console.log('  ' + ch.key + ': ' + ch.from + ' → ' + ch.to));
       }
       if (r.source === 'fallback') {
         console.log('WARNING: config endpoint unreachable — using hardcoded prod URLs. If the key is for a non-prod environment, telemetry will go to the wrong place.');
       }
     });
   "
   ```

5. **Resolve target scope** — determine where OTEL vars should live:

   If the user provided `--user` or `--project`, use that as the explicit target scope. Otherwise, auto-detect:
   ```bash
   RESOLVE_RAW=$(node "$PLUGIN_DIR/lib/settings.js" resolve-scope --project-dir "$CLAUDE_PROJECT_DIR")
   # Output format: action:targetScope:removeScopes (colon-delimited)
   RESOLVE_ACTION="${RESOLVE_RAW%%:*}"
   RESOLVE_REST="${RESOLVE_RAW#*:}"
   TARGET_SCOPE="${RESOLVE_REST%%:*}"
   REMOVE_SCOPES="${RESOLVE_REST#*:}"
   ```

   If user provided an explicit flag that differs from `TARGET_SCOPE`, prompt for migration confirmation:
   - `--user` when current is `project`: **Prompt:** "Prism is currently active only in this project. Switching to user scope will enable telemetry in *every* project. Continue? [y/N]"
   - `--project` when current is `user`: **Prompt:** "Prism is currently active globally. Switching to project scope will stop telemetry in other projects. Continue? [y/N]"

   If `RESOLVE_ACTION` is `skip` (scope unknown, no existing OTEL): Ask the user — "Install for this project only (`--project`) or all projects (`--user`)?" Use the answer as `TARGET_SCOPE`.

   If `RESOLVE_ACTION` is `repair`: the resolver detected misplaced OTEL. Proceed to step 7 with `REMOVE_SCOPES` to clean up before syncing.

6. (Merged into step 5)

7. **Apply the decision:**
   ```bash
   # Remove from the other scope if migrating
   node "$PLUGIN_DIR/lib/settings.js" remove --scope <other-scope> --project-dir "$CLAUDE_PROJECT_DIR"

   # Sync to the target scope
   node "$PLUGIN_DIR/lib/settings.js" sync --scope <target-scope> --project-dir "$CLAUDE_PROJECT_DIR"
   ```
   Show the resolved ingest URL so the user can confirm it's correct.

8. **Notify the dashboard** that setup is complete. Best-effort — never block on the result; the dashboard's Verify modal will fall back to the first-prompt signal if this ping doesn't land. Auth-resolved `developer_id` / `org_id` are written server-side; we only send a minimal body.

   ```bash
   node -e "
     const { notifySetupComplete } = require('$PLUGIN_DIR/lib/notify');
     notifySetupComplete('$API_KEY').then(ok => {
       if (!ok) console.log('(setup-complete ping skipped — dashboard will fall back to first-prompt detection)');
     });
   "
   ```

9. Gateway routing is OFF by default. Inform the user:
   > Gateway routing **disabled** — Claude Code calls Anthropic directly. Telemetry and PRISM scoring still work.
   > To enable budget enforcement, guardrails, and usage logging: `/prism:status` then ask to toggle gateway routing.

10. Confirm what was done and remind: "Scope: **<target>** (`<file-path>`). **Restart Claude Code to activate telemetry.**"

11. End with this call-to-action (verbatim):
    > 🚀 **Next:** open https://dashboard.prism.optra-ai.com/ for realtime coaching, PRISM scores, and insights.
