---
name: prism:status
description: Show Prism connection status, toggle gateway routing
user-invocable: true
---

Show the Prism plugin configuration, connection health, and allow gateway toggling.

1. **API key:** Read `~/.prism/config.json`. Show key prefix (e.g., `gck_abc12...`). If missing: "Run `/prism:setup gck_YOUR_KEY`. Get your key at https://dashboard.prism.optra-ai.com/setup"

2. **Gateway routing:** Read `enableGateway` from config. Show current mode:
   - **Gateway (default)** — budget limits, guardrails, usage logging
   - **Direct** — bypass gateway, call Anthropic directly
   Show the gateway URL from `~/.prism/config-cache.json` field `gateway_url` (NOT from `$ANTHROPIC_BASE_URL` env var — it may be stale). If cache is missing, show "not resolved".
   Note: Telemetry, PRISM scoring, and waste detection work in both modes.

3. **Toggle gateway:** If the user says "toggle", "switch", or "change" routing: update `enableGateway` in `~/.prism/config.json` (read-modify-write to preserve other fields). Confirm the change and remind to restart Claude Code.

3b. **Status line:** Read `showStatusLine` from config (default: true). Show current state: **On** or **Off**. If the user says "toggle status line", "hide status line", or "show status line": update `showStatusLine` in `~/.prism/config.json`. Confirm and remind to restart Claude Code.

4. **Endpoints:** Read all URLs from `~/.prism/config-cache.json` (source of truth). Do NOT use env vars like `$PRISM_INGEST_URL` or `$ANTHROPIC_BASE_URL` — they may be stale from a previous hook. Show:
   - **Ingest URL:** `ingest_url` field (fallback: `https://ingest.prism.optra-ai.com`)
   - **Gateway URL:** `gateway_url` field (if gateway enabled)
   - **OTEL Logs:** `$OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` (fallback: `https://ingest.prism.optra-ai.com/v1/logs`)
   - **OTEL Metrics:** `$OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (fallback: `https://ingest.prism.optra-ai.com/v1/metrics`)

5. **Active features:** OTel telemetry (always on), PRISM gate with threshold from config (always on), prompt capture (always on), gateway routing (if enabled).

6. **Session:** Read `${CLAUDE_PLUGIN_DATA}/session-state.json` for turn count and duration.

End with: "Run `/prism:help` for all commands."
