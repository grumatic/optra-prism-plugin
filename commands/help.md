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
  /prism:setup [gck_KEY]   Register API key, enable telemetry + gateway
  /prism:status            Connection health, gateway toggle, session info
  /prism:uninstall         Remove plugin, clear all settings

During a Session
  /prism:cost              Session cost, token usage, compact tip
  /prism:score             Weakest area, coaching tips, optimization advice
  /prism:advisor [prompt]  Optimize a prompt — efficiency score, rewrite, and tips

After a Session
  /prism:report            Full review — profile, habits, worst prompts, cost optimization

Automatic (hooks — no command needed)
  Prompt advisor   Reviews prompts in realtime with rewrite advice when helpful
  Response timer   Shows elapsed time and token count after each response
  Context nudge    Smart /compact and /clear advice based on context growth

Getting started:
  1. /prism:setup gck_YOUR_KEY    Set up your API key
  2. Start coding                 Telemetry and scoring activate automatically
  3. /prism:score                 See where to improve
  4. /prism:report                Review your session

Get your API key:  https://dashboard.prism.optra-ai.com/setup
Documentation:     https://prism.optra-ai.com/docs
```

Do not add any extra commentary beyond what is shown above. Display it exactly as formatted.
