---
name: prism:realtime
description: Show the current session's realtime Prism summary (grade, cost, context, turns)
user-invocable: true
---

Show the realtime Prism summary for the current session.

1. Run:
   ```bash
   node "$PLUGIN_DIR/lib/realtime-status.js" --session "$CLAUDE_CODE_SESSION_ID"
   ```
2. Display the script output verbatim (it is already formatted). The first line is the same `[Prism] Lite <grade> · <cost> · ctx <percent> · turn <count>` summary the Stop hook shows automatically on the CLI.
3. If the output is the "No realtime data yet" message, show it as-is and add: "Complete one prompt first, then run `/prism:realtime` again."
4. If the first line ends with "(latest session)", the summary came from the most recent session on this machine because the current session has no completed turns yet — mention that in one short sentence.

Notes for context (do not print unless asked): on the Claude Code CLI this summary also appears automatically at the end of every captured turn; this command exists as the on-demand equivalent for hosts that do not render hook messages, such as the VS Code extension panel. Display is read-only and never changes capture behavior.

Do not add any extra commentary beyond the above.
