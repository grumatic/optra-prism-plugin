---
name: prism:doctor
description: Diagnose Prism plugin configuration and connectivity issues
user-invocable: true
allowed-tools: Bash(node:*)
---

Run:
```bash
node "$PLUGIN_DIR/lib/doctor.js" --project-dir "$CLAUDE_PROJECT_DIR"
```

Display the output verbatim.
