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
   Write JSON to `~/.prism/config.json` with: `apiKey`, `prismThreshold` (preserved or 4), `enableGateway: true`. Then `chmod 600 ~/.prism/config.json`.

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

5. **Detect the current scope** and decide where to write OTEL vars:
   ```bash
   CURRENT_SCOPE=$(node "$PLUGIN_DIR/lib/settings.js" detect --project-dir "$CLAUDE_PROJECT_DIR")
   ```
   - `user`, `project`, `both`, or `none`.

6. **Resolve target scope** based on user args and `CURRENT_SCOPE`:

   | User flag | `CURRENT_SCOPE` | Behavior |
   |---|---|---|
   | `--user` | `user` or `none` | Target = `user`. No migration prompt. |
   | `--user` | `project` | **Prompt:** "Prism is currently active only in this project. Switching to user scope will enable telemetry in *every* project you open with Claude Code. Continue? [y/N]" — on yes: remove project, then sync user. |
   | `--user` | `both` | Same prompt as above (we'll clean up the project side after confirm). |
   | `--project` | `project` or `none` | Target = `project`. No migration prompt. |
   | `--project` | `user` | **Prompt:** "Prism is currently active globally (user scope). Switching to project scope will stop telemetry in all your other projects. Continue? [y/N]" — on yes: remove user, then sync project. |
   | `--project` | `both` | Same prompt as above. |
   | *(no flag)* | `user` | Target = `user`. |
   | *(no flag)* | `project` | Target = `project`. |
   | *(no flag)* | `both` | **Prompt:** "Prism is active in both user scope and this project. Pick one to keep: [user/project]" — remove the other. |
   | *(no flag)* | `none` | Target = `user` (default). |

7. **Apply the decision:**
   ```bash
   # Remove from the other scope if migrating
   node "$PLUGIN_DIR/lib/settings.js" remove --scope <other-scope> --project-dir "$CLAUDE_PROJECT_DIR"

   # Sync to the target scope
   node "$PLUGIN_DIR/lib/settings.js" sync --scope <target-scope> --project-dir "$CLAUDE_PROJECT_DIR"
   ```
   Show the resolved ingest URL so the user can confirm it's correct.

8. Gateway routing is ON by default. Inform the user:
   > Gateway routing **enabled**. Budget enforcement, guardrails, and usage logging active.
   > To toggle routing mode: `/prism:status`

9. Confirm what was done and remind: "Scope: **<target>** (`<file-path>`). **Restart Claude Code to activate telemetry.**"
