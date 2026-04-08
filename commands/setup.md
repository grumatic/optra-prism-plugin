---
name: setup
description: Configure the Prism plugin with your gck_* API key
user-invocable: true
---

Configure the Prism plugin with a `gck_*` API key.

**Usage:** `/prism:setup gck_YOUR_KEY`

No API key? Get one at: https://dashboard.prism.optra-ai.com/setup

**Steps:**

1. Read existing config from `~/.prism/config.json` (if it exists). If a key already exists and no new key was provided, show the prefix (e.g., `gck_abc12...`) and ask if they want to replace it.

2. Validate the key starts with `gck_`. If not: "Usage: `/prism:setup gck_YOUR_KEY`"

3. Write the config (preserve existing `prismThreshold`, default to 4):
   ```bash
   mkdir -p ~/.prism && chmod 700 ~/.prism
   ```
   Write JSON to `~/.prism/config.json` with: `apiKey`, `prismThreshold` (preserved or 4), `enableGateway: true`. Then `chmod 600 ~/.prism/config.json`.

4. Fetch the latest service URLs from the server, compare with cache, and update OTEL settings:
   ```bash
   # Fetch config from endpoint, compare with cache, and update
   node -e "
     const c = require('$PLUGIN_DIR/lib/config');
     c.fetchConfig('$API_KEY').then(r => {
       if (!r) { console.log('Using production fallback URLs'); return; }
       console.log('Config cached: ' + r.ingest_url);
       if (r._changed && r._changed.length > 0) {
         console.log('URLs updated:');
         r._changed.forEach(ch => console.log('  ' + ch.key + ': ' + ch.from + ' → ' + ch.to));
       }
     });
   "
   # Sync OTEL env vars to ~/.claude/settings.json using cached URLs
   node "$PLUGIN_DIR/lib/settings.js" sync
   ```
   Where `$PLUGIN_DIR` is the plugin directory and `$API_KEY` is the key from step 2.
   Show the resolved ingest URL so the user can confirm it's correct. If any URLs changed from the previous cache, show them.

5. Gateway routing is ON by default. Inform the user:
   > Gateway routing **enabled**. Budget enforcement, guardrails, and usage logging active.
   > To toggle routing mode: `/prism:status`

6. Remind: "**Restart Claude Code to activate telemetry.**"
