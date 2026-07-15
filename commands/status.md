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

2. **Status line:** Read `showStatusLine` from config (default: true). Show current state: **On** or **Off**. If the user says "toggle status line", "hide status line", or "show status line": update `showStatusLine` in `~/.prism/config.json` with a read-modify-write that preserves all other fields. Confirm and remind to restart Claude Code.

3. **Endpoints:** Resolve the effective ingest URL with `$PLUGIN_DIR/lib/config.js` using this priority: `PRISM_INGEST_URL` → `~/.prism/config.json.ingest_url` → `~/.prism/config-cache.json.ingest_url` → production. Show:
   - **Ingest URL:** effective resolved `ingest_url` (report an invalid explicit override instead of falling back)
   - **OTEL Logs:** `$OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (expected: `<effective-ingest-url>/v1/logs`)
   - **OTEL Metrics:** `$OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (expected: `<effective-ingest-url>/v1/metrics`)

4. **Active features:** OTel telemetry (always on), PRISM gate with threshold from config (always on), and prompt capture (always on).

5. **Session:** Read `${CLAUDE_PLUGIN_DATA}/session-state.json` for turn count and duration.

End with two lines:
1. "Run `/prism:help` for all commands."
2. "🚀 **Next:** open https://dashboard.optra-prism.com/ for realtime coaching, PRISM scores, and insights."
