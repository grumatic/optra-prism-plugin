---
name: prism:status
description: Show Prism connection status, toggle gateway routing
user-invocable: true
---

Show the Prism plugin configuration, connection health, and allow gateway toggling.

1. **API key:** Read `~/.prism/config.json`. Show key prefix (e.g., `gck_abc12...`). If missing: "Run `/prism:setup gck_YOUR_KEY`. Get your key at https://dashboard.prism.optra-ai.com/setup"

1b. **Install scope:** Detect which scope currently holds the OTEL env vars:
   ```bash
   node "$PLUGIN_DIR/lib/settings.js" detect --project-dir "$CLAUDE_PROJECT_DIR"
   ```
   Output is one of `user` | `project` | `both` | `none`. Display it:
   - `user` → **Scope: user** (`~/.claude/settings.json`) — active in every project.
   - `project` → **Scope: project** (`$CLAUDE_PROJECT_DIR/.claude/settings.local.json`) — active only in this project.
   - `both` → **Scope: both** — warn: "OTEL vars exist in both user and project scopes. Run `/prism:setup` to pick one."
   - `none` → "Prism is not activated yet. Run `/prism:setup gck_YOUR_KEY`."
   If `detect` printed a WARNING to stderr (e.g. OTEL vars found in the shared `.claude/settings.json`), surface it here prominently — that warning means a gck_* key may have been committed to git.

2. **Gateway routing:** Read `enableGateway` from config. Show current mode:
   - **Direct (default)** — bypass gateway, call Anthropic directly
   - **Gateway** — budget limits, guardrails, usage logging
   Show the gateway URL from `~/.prism/config-cache.json` field `gateway_url` (NOT from `$ANTHROPIC_BASE_URL` env var — it may be stale). If cache is missing, show "not resolved".
   Note: Telemetry and PRISM scoring work in both modes.

3. **Toggle gateway:** If the user says "toggle", "switch", or "change" routing: update `enableGateway` in `~/.prism/config.json` (read-modify-write to preserve other fields). Confirm the change and remind to restart Claude Code.

3b. **Status line:** Read `showStatusLine` from config (default: true). Show current state: **On** or **Off**. If the user says "toggle status line", "hide status line", or "show status line": update `showStatusLine` in `~/.prism/config.json`. Confirm and remind to restart Claude Code.

4. **Endpoints:** Read all URLs from `~/.prism/config-cache.json` (source of truth). Do NOT use env vars like `$PRISM_INGEST_URL` or `$ANTHROPIC_BASE_URL` — they may be stale from a previous hook. Show:
   - **Ingest URL:** `ingest_url` field (fallback: `https://ingest.prism.optra-ai.com`)
   - **Gateway URL:** `gateway_url` field (if gateway enabled)
   - **OTEL Logs:** `$OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (fallback: `https://ingest.prism.optra-ai.com/v1/logs`)
   - **OTEL Metrics:** `$OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (fallback: `https://ingest.prism.optra-ai.com/v1/metrics`)

5. **Active features:** OTel telemetry (always on), PRISM gate with threshold from config (always on), prompt capture (always on), gateway routing (if enabled).

6. **Session:** Read `${CLAUDE_PLUGIN_DATA}/session-state.json` for turn count and duration.

End with two lines:
1. "Run `/prism:help` for all commands."
2. "🚀 **Next:** open https://dashboard.prism.optra-ai.com/ for realtime coaching, PRISM scores, and insights."
