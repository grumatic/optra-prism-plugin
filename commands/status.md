---
name: prism:status
description: Show Prism connection status and session information
user-invocable: true
---

Show the Prism plugin configuration and connection health.

1. **API key:** Read `~/.prism/config.json`. If present, show **Prism API key: configured** without displaying any part of the key. If missing: "Run `/prism:setup prism_YOUR_KEY`. Get your key at https://dashboard.optra-prism.com/setup"

1b. **Install scope:** Detect which scope currently holds the OTEL env vars:
   ```bash
   node "$PLUGIN_DIR/lib/settings.js" detect --project-dir "$CLAUDE_PROJECT_DIR"
   ```
   Output is one of `user` | `project` | `both` | `none`. Display it:
   - `user` → **Scope: user** (`~/.claude/settings.json`) — active in every project.
   - `project` → **Scope: project** (`$CLAUDE_PROJECT_DIR/.claude/settings.local.json`) — active only in this project.
   - `both` → **Scope: both** — warn: "OTEL vars exist in both user and project scopes. Run `/prism:setup` to pick one."
   - `none` → "Prism is not activated yet. Run `/prism:setup prism_YOUR_KEY`."
   If `detect` printed a WARNING to stderr (e.g. OTEL vars found in the shared `.claude/settings.json`), surface it here prominently — that warning means a Prism API key may have been committed to git.

2. **Realtime summary:** `showRealtimeSummary` controls the on-screen Lite summary and context nudge messages. Resolve its effective **On** or **Off** value with `$PLUGIN_DIR/lib/options.js` and display its source: `env-official`, `env-compat`, `legacy`, or `default`. The priority is `CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY` → `CLAUDE_PLUGIN_OPTION_showRealtimeSummary` → own-property `~/.prism/config.json.showRealtimeSummary` → default **On**. Only boolean values and exact lowercase strings `true` / `false` are valid. An invalid value at any selected source must be shown as an error and use the safe default **On**, without falling through to a lower-priority source.

   If the user asks to toggle, hide, or show realtime summaries, only update the legacy config when neither environment source is present. A legacy write is masked while either environment source is active; do not report it as changing the effective setting. Preserve all other config fields.

   **Show Status Line:** `showStatusLine` is deprecated and has no supported effect. Claude Code terminal status lines are not supported by this plugin; display this setting only as **Deprecated** and do not offer to toggle or migrate it.

3. **Correlation and Lite display:** Prompt and response capture use exact host `prompt_id` correlation within the same session and epoch; unmatched, stale, or unproven transcript turns are skipped. Successful proven responses update the `[Prism] Lite <grade> · <cost> · ctx <percent> · turn <count>` summary. Context nudges use that summary's growth and turn count: over 3× growth recommends `/compact`; over 10× growth or over 80 turns recommends `/clear`.

4. **Endpoints:** Resolve the effective ingest URL with `$PLUGIN_DIR/lib/config.js` using this priority: `PRISM_INGEST_URL` → `~/.prism/config.json.ingest_url` → `~/.prism/config-cache.json.ingest_url` → production. Show:
   - **Ingest URL:** effective resolved `ingest_url` (report an invalid explicit override instead of falling back)
   - **OTEL Logs:** `$OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (expected: `<effective-ingest-url>/v1/logs`)
   - **OTEL Metrics:** `$OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (expected: `<effective-ingest-url>/v1/metrics`)

5. **Active features:** OTel telemetry (always on), PRISM gate with threshold from config (always on), and prompt capture (always on).

6. **Session:** Realtime session totals are stored in isolated, hashed runtime records and are intentionally not read from global command state.

End with two lines:
1. "Run `/prism:help` for all commands."
2. "🚀 **Next:** open https://dashboard.optra-prism.com/ for realtime coaching, PRISM scores, and insights."
