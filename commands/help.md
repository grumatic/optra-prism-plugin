---
name: prism:help
description: Show all available Prism plugin commands and how to use them
user-invocable: true
---

Show the user all available Prism plugin commands grouped by category.

Display the following:

```
Prism Plugin Commands

Setup & Config
  /prism:setup [prism_KEY] Register Prism API key and enable telemetry
  /prism:status            Connection health, Lite session summary, exact correlation info
  /prism:uninstall         Remove plugin, clear all settings

Review
  /prism:realtime           Current session summary on demand — grade, cost, context, turns
  /prism:report            Weekly review — this week vs last week, PRISM grade, habits, worst prompts

Automatic (hooks — no command needed)
  Prompt/response capture Uses exact host prompt_id correlation; unmatched turns are skipped
  Lite summary         Shows grade, cost, context, and turn count when enabled
  Lite summary (VS Code)  Panel does not render hook messages; use /prism:realtime
  Context nudge        Recommends /compact above 3× growth; /clear above 10× or 80 turns
  Terminal status line  Not supported; showStatusLine is deprecated

Getting started:
  1. /prism:setup prism_YOUR_KEY  Set up your Prism API key
  2. Start coding                 Telemetry activates automatically
  3. /prism:report                Compare this week vs last week

Dashboard:         https://dashboard.optra-prism.com/
Get your API key:  https://dashboard.optra-prism.com/setup
Documentation:     https://optra-prism.com/docs
```

Do not add any extra commentary beyond what is shown above. Display it exactly as formatted.
