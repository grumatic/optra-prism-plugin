---
name: prism:realtime
description: Show the current session's realtime Prism score summary (grade, cost, turns)
user-invocable: true
allowed-tools: Bash(node:*)
---

Realtime Prism summary for the current session:

!`node "${CLAUDE_PLUGIN_ROOT}/lib/realtime-status.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}"`

Display the output above verbatim (it is already formatted). The first line is the same `[Prism] <grade> [live] · <intent> <outcome> · (t<start>–<end>) · <cost> · <turns> turns` score summary the Stop hook shows automatically on the CLI.

- If the output is the "No realtime data yet" message, show it as-is and add: "Complete one prompt first, then run `/prism:realtime` again."
- If the first line ends with "(latest session)", the summary came from the most recent session on this machine because the current session has no completed turns yet — mention that in one short sentence.

Do not add any extra commentary beyond the above.
