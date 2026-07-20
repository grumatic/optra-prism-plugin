---
name: prism:setup
description: Configure the Prism plugin with your Prism API key
user-invocable: true
---

Configure Prism with a Prism API key.

**Usage:** `/prism:setup KEY`

No API key? Get one at: https://dashboard.optra-prism.com/setup

Parse `$ARGUMENTS` as exactly one non-empty key. Scope flags are not supported. Treat the key as opaque: do not validate its prefix or modify it; the backend response determines whether it is accepted. When no key was given, show the usage above and do not run the script.

Run this single command:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/setup.js" apply "$KEY" --project-dir "${CLAUDE_PROJECT_DIR}"
```

Pass the key only as the positional argument shown above. The script detects the installed plugin scope and writes only its corresponding settings file. Do not read or write Prism configuration files yourself. Display the script's stdout and stderr verbatim.

> 🚀 **Next:** open https://dashboard.optra-prism.com/ for realtime coaching, PRISM scores, and insights.
