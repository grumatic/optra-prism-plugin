---
name: prism:setup
description: Configure the Prism plugin with your Prism API key
user-invocable: true
---

Configure Prism with a Prism API key.

**Usage:**
- `/prism:setup prism_YOUR_KEY`
- `/prism:setup prism_YOUR_KEY --user`
- `/prism:setup prism_YOUR_KEY --project`

No API key? Get one at: https://dashboard.optra-prism.com/setup

**Scope rules:**
- OTEL environment variables, including the Prism API key, live in exactly one scope.
- User scope applies to every project; project scope applies only to this project.
- Prism never uses `$CLAUDE_PROJECT_DIR/.claude/settings.json` because it may be shared or committed. Switching scopes moves variables rather than duplicating them.

Extract the API key and optional `--user` or `--project` flag from the user's command arguments. Run this single command, translating `--user` to `--scope user` and `--project` to `--scope project`:

```bash
PRISM_API_KEY="$KEY" node "$PLUGIN_DIR/lib/setup.js" apply [--scope user|project] --project-dir "$CLAUDE_PROJECT_DIR"
```

Pass the key only through `PRISM_API_KEY`; never interpolate it anywhere else. Do not read or write Prism configuration files yourself. Display the script's stdout verbatim.

When the script exits 3, show its `CONFIRM_REQUIRED` reason and ask: `Continue? [y/N]`. On yes, rerun the same command with `--confirm`; otherwise stop.

When no key argument was given, run `node "$PLUGIN_DIR/lib/setup.js" apply --check-existing`. State `Prism API key configured` only when it prints `KEY_PRESENT`; otherwise ask for a key.

> 🚀 **Next:** open https://dashboard.optra-prism.com/ for realtime coaching, PRISM scores, and insights.
