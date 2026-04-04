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
   Show the gateway URL from `$ANTHROPIC_BASE_URL` if enabled.
   Note: Telemetry, PRISM scoring, and waste detection work in both modes.

3. **Toggle gateway:** If the user says "toggle", "switch", or "change" routing: update `enableGateway` in `~/.prism/config.json` (read-modify-write to preserve other fields). Confirm the change and remind to restart Claude Code.

3b. **Status line:** Read `showStatusLine` from config (default: true). Show current state: **On** or **Off**. If the user says "toggle status line", "hide status line", or "show status line": update `showStatusLine` in `~/.prism/config.json`. Confirm and remind to restart Claude Code.

4. **Endpoints:** Show these env vars: `PRISM_INGEST_URL`, `ANTHROPIC_BASE_URL` (if gateway enabled), `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. If empty, tell user to restart Claude Code.

5. **Active features:** OTel telemetry (always on), PRISM gate with threshold from config (always on), prompt capture (always on), gateway routing (if enabled).

6. **Session:** Read `${CLAUDE_PLUGIN_DATA}/session-state.json` for turn count and duration.

End with: "Run `/prism:help` for all commands."
