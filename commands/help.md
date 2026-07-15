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
  /prism:setup [gck_KEY]   Register API key and enable telemetry
  /prism:status            Connection health, status line, session info
  /prism:uninstall         Remove plugin, clear all settings

Review
  /prism:report            Weekly review — this week vs last week, PRISM grade, habits, worst prompts

Automatic (hooks — no command needed)
  Prompt advisor   Reviews prompts in realtime with rewrite advice when helpful
  Response timer   Shows elapsed time and token count after each response
  Context nudge    Smart /compact and /clear advice based on context growth

Getting started:
  1. /prism:setup gck_YOUR_KEY    Set up your API key
  2. Start coding                 Telemetry activates automatically
  3. /prism:report                Compare this week vs last week

Dashboard:         https://dashboard.optra-prism.com/
Get your API key:  https://dashboard.optra-prism.com/setup
Documentation:     https://optra-prism.com/docs
```

Do not add any extra commentary beyond what is shown above. Display it exactly as formatted.
