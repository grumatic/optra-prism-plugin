---
name: prism:setup
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

4. Gateway routing is ON by default. Inform the user:
   > Gateway routing **enabled**. Budget enforcement, guardrails, and usage logging active.
   > To toggle routing mode: `/prism:status`

5. Remind: "**Restart Claude Code for changes to take effect.**"
