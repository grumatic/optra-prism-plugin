---
name: prism:doctor
description: Diagnose Prism plugin configuration and connectivity issues
user-invocable: true
allowed-tools: Bash(node:*)
---

Prism diagnostic report:

!`node "${CLAUDE_PLUGIN_ROOT}/lib/doctor.js" --project-dir "${CLAUDE_PROJECT_DIR}"`

Display the output above verbatim.
