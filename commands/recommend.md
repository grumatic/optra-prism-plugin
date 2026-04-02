---
description: Get optimization recommendations to save tokens and time
user-invocable: true
---

Provide the user with actionable recommendations to save tokens and time based on common optimization patterns. Cover these areas:

**Model optimization:**
- If doing simple tasks (file edits, boilerplate, formatting), suggest `/model sonnet` or `/model haiku`
- For planning + implementation, suggest `/model opusplan` (Opus plans, Sonnet implements — 68% savings vs all-Opus)
- Match `/effort` level to task: `/effort low` for simple edits, `/effort max` only for complex architecture

**Context management:**
- `/compact` every 2-3 completed tasks (reduces context by ~70%)
- `/clear` when switching to unrelated work
- Keep CLAUDE.md under 200 lines — move specialized instructions into skills
- Use `.claudeignore` to exclude node_modules, dist, build, lock files

**Prompt quality:**
- One atomic task per prompt (PRISM atomicity dimension)
- Reference specific files and line numbers (PRISM specificity)
- State acceptance criteria ("should return X", "test should pass for Y")
- Start with imperative verbs (Fix, Add, Remove)

**Tooling:**
- LSP plugins (`typescript-lsp`, `pyright-lsp`) — Claude queries types instead of reading files (20-40% fewer input tokens)
- Subagents for parallel independent tasks — keeps main context clean
- Hooks for auto-format/lint — prevents manual cleanup cycles

**Dashboard recommendations:**
- Point them to the Prism recommendations engine at `/recommendations` for data-driven suggestions specific to their usage (model switching savings, error reduction, plan right-sizing)
