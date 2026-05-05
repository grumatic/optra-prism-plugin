---
name: prism:doctor
description: Diagnose Prism plugin configuration and connectivity issues
user-invocable: true
---

Run the Prism diagnostic checks and display a structured report.

1. **Run checks:**
   ```bash
   node "$PLUGIN_DIR/lib/doctor.js" --project-dir "$CLAUDE_PROJECT_DIR"
   ```
   This outputs JSON with `checks[]`, `summary`, and `autoFixed[]`.

2. **Parse the JSON output** and format a report using the structure below.

3. **Display the report:**

   Start with the summary line:
   > **Prism Doctor** — X passed, Y warnings, Z failed

   Then show the checks table:

   | # | Check | Status | Details |
   |---|-------|--------|---------|
   | 1 | API Key | PASS / WARN / FAIL | message from check |
   | 2 | OTEL Scope | PASS / WARN / FAIL | message from check |
   | 3 | Config Cache | PASS / WARN / FAIL | message from check |
   | 4 | Ingest Connectivity | PASS / WARN / FAIL | message from check |
   | 5 | Process Env Sync | PASS / WARN / FAIL | message from check |

   Use these status labels:
   - `pass` → **PASS**
   - `warn` → **WARN**
   - `fail` → **FAIL**

4. **Auto-fixed items:** If `autoFixed[]` is non-empty, show:
   > **Auto-fixed:**
   > - (each item from the autoFixed array)

5. **Issues found:** For each check with status `warn` or `fail`, show:
   > **Issues:**
   > 1. [Check name]: [message] — **Fix:** [remediation]

   Use the `remediation` field from each check result. If remediation is null, omit the fix line.

6. **If all checks pass and no auto-fixes were made:**
   > All checks passed. Your Prism configuration is healthy.

7. End with: "Run `/prism:help` for all commands."
