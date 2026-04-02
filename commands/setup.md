---
description: Configure the Prism plugin — enter your gck_* API key and choose gateway routing
user-invocable: true
---

Configure the Prism plugin with a `gck_*` API key and optional gateway routing.

**Usage:** `/prism:setup` or `/prism:setup gck_YOUR_KEY`

**Steps:**

1. First, locate the plugin root directory. Determine `PLUGIN_ROOT` by checking these locations in order:
   - `$CLAUDE_PLUGIN_ROOT` (if set by Claude Code)
   - The directory containing this command file, resolved to the plugin root (two levels up from `commands/`)
   - As a last resort: `$HOME/.prism/claude-code-plugin`

   Run:
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
   if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/lib/settings.js" ]; then
     for p in \
       "$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)" \
       "$HOME/.prism/claude-code-plugin"; do
       if [ -f "$p/lib/settings.js" ]; then PLUGIN_ROOT="$p"; break; fi
     done
   fi
   echo "PLUGIN_ROOT=${PLUGIN_ROOT:-NOT FOUND}"
   ```

   If `PLUGIN_ROOT` is NOT FOUND, tell the user the plugin directory could not be located.

2. Check if a key already exists by reading `~/.prism/config.json`:
   ```bash
   cat ~/.prism/config.json 2>/dev/null || echo "{}"
   ```

3. **If a key already exists** (the file has an `apiKey` field starting with `gck_`):
   - Show the user the key prefix (first 12 characters + `...`), e.g.: "Current API key: `gck_acme_pr...`"
   - If no new key was provided as argument, ask: "Do you want to replace this key? Run `/prism:setup gck_YOUR_NEW_KEY` to replace it."
   - If a new key was provided as argument, ask the user to confirm: "Replace existing key `gck_acme_pr...` with `gck_new_key_...`? (yes/no)"
   - Only proceed to step 4 if the user confirms.

4. **If no key exists**, or the user confirmed replacement:
   - Extract the key from the argument. If no argument or key doesn't start with `gck_`, tell the user: "Usage: `/prism:setup gck_YOUR_KEY`"
   - Read the existing config to preserve fields:
     ```bash
     EXISTING=$(node -e "try { const c = JSON.parse(require('fs').readFileSync(process.env.HOME + '/.prism/config.json', 'utf8')); process.stdout.write(JSON.stringify({ env: c.env || '', threshold: c.prismThreshold || 4, gateway: c.enableGateway || 'false' })); } catch { process.stdout.write(JSON.stringify({ env: '', threshold: 4, gateway: 'false' })); }" 2>/dev/null)
     ```

5. **Ask about gateway routing:**
   - Explain the two modes:
     - **Telemetry only** (default): OTEL export + prompt scoring. API calls go directly to Anthropic. No latency impact.
     - **Full governance**: API calls routed through Optra gateway for budget enforcement, guardrails, and full request/response logging. Adds a small latency hop.
   - Ask: "Enable gateway routing? (yes/no, default: no)"
   - If yes, set `ENABLE_GATEWAY=true`. If no or skipped, set `ENABLE_GATEWAY=false`.

6. Write the config file:
   ```bash
   mkdir -p ~/.prism && chmod 700 ~/.prism && cat > ~/.prism/config.json << 'PRISM_EOF'
   {
     "apiKey": "<the gck_* key>",
     "prismThreshold": <preserved or 4>,
     "env": "<preserved if non-empty, otherwise 'local'>",
     "enableGateway": "<true or false>"
   }
   PRISM_EOF
   chmod 600 ~/.prism/config.json
   ```

7. Sync OTEL env vars to `~/.claude/settings.json` and verify:
   ```bash
   node "$PLUGIN_ROOT/lib/settings.js" sync && node "$PLUGIN_ROOT/lib/settings.js" check
   ```
   - If check outputs `ok`: Confirm "API key saved and OTEL telemetry configured."
   - Show gateway status: "Gateway routing: **enabled**" or "Gateway routing: **disabled** (telemetry only)"
   - Always remind: "**Restart Claude Code for changes to take effect.**"
   - If check fails: Warn "API key saved but OTEL settings could not be verified."
