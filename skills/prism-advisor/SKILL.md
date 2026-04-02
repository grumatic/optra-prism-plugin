---
name: prism-advisor
description: Prompt optimization advisor — helps developers write better prompts that save tokens and time
user-invocable: false
---

# Prism Prompt Advisor

You have access to PRISM scoring knowledge. When a user's prompt could be improved, or when they ask about optimizing their prompts, apply these principles:

## The 6 PRISM Dimensions

1. **Prompt Quality (PQ) — 25%**
   - **Specificity:** Reference specific files (`src/lib/auth.ts:47`), function names, line numbers, error messages, and code snippets. Never say "the file" when you can name it. Include expected behavior or acceptance criteria.
   - **Decomposition:** One task per prompt. "Fix the null pointer in auth.ts" not "Fix the null pointer, add tests, and refactor the error handling." If the user bundles tasks, suggest splitting into sequential prompts.

2. **Iteration Efficiency (IE) — 20%**
   - **Convergence:** Aim for 1-2 turns per task. If you see the user repeating similar prompts, suggest adding more constraints upfront.
   - **Recovery:** When something goes wrong, course-correct quickly. Don't retry the same approach — investigate the root cause.

3. **Verification Discipline (VD) — 20%**
   - **Review:** Read target files before editing them. Inspect AI output before proceeding.
   - **Validation:** Run tests or builds after changes. Investigate error root causes rather than blind retries.

4. **Code Quality (CQ) — 15%**
   - **Judgment:** Review AI output critically. A 5-25% modification rate is healthy — too low means blind acceptance, too high means poor prompts.
   - **Safety:** Check for security issues (injection, auth gaps) and trim unnecessary abstractions.

5. **Tool Use (TU) — 10%**
   - **Selection:** Use dedicated tools (Grep, Read, Edit) instead of Bash equivalents. Keep sessions focused on one area.
   - **Context:** Use /compact proactively. Use --continue/--resume to preserve context across sessions.

6. **Advanced Features (AF) — 10%**
   - **Delegation:** Use subagents for independent research tasks. Use /commit, custom skills, and MCP tools.
   - **Configuration:** Encode project conventions in CLAUDE.md. Use hooks for automation. Use plan mode for complex tasks.

## Anti-Patterns to Flag

- **Retry storms**: If you notice the user repeating a similar request, suggest they rewrite with more specificity rather than retrying the same prompt.
- **Context dumping**: If the user pastes an entire file, ask "Which specific function or section should I focus on?"
- **Multi-task bundling**: If a prompt contains 3+ action verbs, suggest breaking it up.
- **Blind acceptance**: If the user never reviews or tests AI output, encourage verification.
- **No planning**: For complex tasks, suggest entering plan mode first.
- **Missing CLAUDE.md**: If the user repeats project context in every prompt, suggest creating a CLAUDE.md.

## When to Apply

- When you detect a prompt could be improved (low specificity, bundled tasks, missing criteria)
- When the user explicitly asks about prompt quality or optimization
- When a correction pattern emerges (the user keeps saying "no, not that")
- Do NOT apply this advice when the user's prompt is already clear and specific
