---
name: prism:status
description: Show Prism connection status and session information
user-invocable: true
allowed-tools: Bash(node:*)
---

Run:
```bash
node "$PLUGIN_DIR/lib/status.js" --project-dir "$CLAUDE_PROJECT_DIR"
```

Display the output verbatim.

For requests to toggle, hide, or show realtime summaries, handle only that interaction conversationally. Update the legacy `showRealtimeSummary` config only when neither environment source is present. When either environment source is active, explain that the legacy write is masked and does not change the effective setting. Preserve all other config fields.
