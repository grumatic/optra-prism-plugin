---
name: prism:report
description: Weekly review — this week vs last week, PRISM grade, habits, worst prompts
user-invocable: true
allowed-tools: Bash(node:*)
---

Run:
```bash
node "$PLUGIN_DIR/lib/report.js"
```

Display stdout verbatim. On a non-zero exit, display the script's stderr verbatim.