---
name: help
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
  /prism:score             Weakest dimension, coaching tips, optimization advice
  /prism:advisor [prompt]  Optimize a prompt — PQ score, rewrite, and tips

After a Session
  /prism:report            Full review — trends, habits, waste, worst prompts

Automatic (hooks — no command needed)
  Prompt advisor   Scores prompts in realtime, blocks low PQ with rewrite advice
  Response timer   Shows elapsed time and token count after each response
  Context nudge    Smart /compact and /clear advice based on context growth
  Waste alerts     Model overkill warnings every 10 turns

Getting started:
  1. /prism:setup gck_YOUR_KEY    Set up your API key
  2. Start coding                 Telemetry and scoring activate automatically
  3. /prism:score                 See where to improve
  4. /prism:report                Review your session

Get your API key:  https://dashboard.prism.optra-ai.com/setup
Documentation:     https://prism.optra-ai.com/docs
```

Do not add any extra commentary beyond what is shown above. Display it exactly as formatted.
