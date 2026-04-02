---
description: Check your PRISM score and get improvement tips
user-invocable: true
---

Help the user understand and improve their PRISM score.

Explain the 6 PRISM dimensions and their weights:
1. **Prompt Quality (PQ) — 25%** — Specificity (file paths, functions, line numbers, acceptance criteria) + Decomposition (one task per prompt, no bundling)
2. **Iteration Efficiency (IE) — 20%** — Convergence (turns per task, first-try success) + Recovery (course-correction speed)
3. **Verification Discipline (VD) — 20%** — Review (read before edit, inspect output) + Validation (test execution, error investigation)
4. **Code Quality (CQ) — 15%** — Judgment (edit calibration, 5-25% modification rate) + Safety (security awareness, simplification)
5. **Tool Use (TU) — 10%** — Selection (right tool for task) + Context (context hygiene, session management)
6. **Advanced Features (AF) — 10%** — Delegation (subagents, skills) + Configuration (CLAUDE.md, hooks, plan mode)

PRISM uses a 0-10 scale with proficiency levels:
- **9.0-10.0 (Elite)**: Multi-agent workflows, custom skills, cross-system automation
- **7.0-8.9 (Expert)**: Strategic decomposition, subagents, MCP, hooks, plan mode
- **5.0-6.9 (Proficient)**: Good judgment, focused prompts, regular verification
- **3.0-4.9 (Practitioner)**: Functional but inefficient, excessive iteration
- **0.0-2.9 (Novice)**: Treats AI as black box, accepts uncritically

Offer to score their most recent prompt or any prompt they paste in, using these criteria. Provide specific, actionable feedback on how to improve each dimension.

Also suggest:
- Check PRISM trends over time on the Prism dashboard at `/prism`
- Team admins can see per-developer PRISM scores at `/prism` (Team tab)
- The PRISM gate (UserPromptSubmit hook) automatically blocks prompts scoring below the threshold set in `/prism:setup`
