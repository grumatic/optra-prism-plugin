---
name: prism:cost
description: Show current session cost and token usage summary
user-invocable: true
---

Show the user their current session cost information. Read the session state file at `${CLAUDE_PLUGIN_DATA}/session-state.json` to get the turn count and session start time.

Display a summary including:
- Number of turns in this session
- Session duration (time since start)
- A reminder to use `/compact` if turns > 10
- A reminder to use `/model sonnet` for simple tasks if they're on Opus

Also suggest checking the Prism dashboard at `/my-usage` for detailed cost breakdown, model mix, and token efficiency metrics.

If the session state file doesn't exist, tell the user no session data is available yet — it's populated after the first response in a session.
