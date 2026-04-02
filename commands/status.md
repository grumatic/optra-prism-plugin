---
description: Show Prism connection status and plugin configuration
user-invocable: true
---

Check the Prism plugin configuration and show the user their connection status.

1. **API key:** Read `~/.prism/config.json`. If it exists and has `apiKey`, show the prefix (e.g., `gck_abc123...`). If missing, tell the user to run `/prism:setup`.

2. **Gateway routing:** Read `enableGateway` from `~/.prism/config.json`:
   - If `true`: Show "Gateway routing: **enabled** — API calls route through Optra gateway"
   - Show the gateway URL from `ANTHROPIC_BASE_URL` env var
   - If `false` or missing: Show "Gateway routing: **disabled** — API calls go directly to Anthropic (telemetry only)"
   - Mention: "Run `/prism:setup` to change gateway routing."

3. **Connection status:** Show these env vars (auto-set by the SessionStart hook):
   - `PRISM_INGEST_URL` — Ingest service endpoint
   - `PRISM_CODER_URL` — Dashboard endpoint
   - `ANTHROPIC_BASE_URL` — Gateway URL (only shown if gateway enabled)
   - `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` — OTel endpoint
   - If these are empty, the plugin hasn't activated yet — tell the user to restart Claude Code after running `/prism:setup`.

4. **Active features:**
   - OTel telemetry: session/prompt events sent to ingest (always on)
   - PRISM gate: prompts below threshold (from config) are blocked with coaching (always on)
   - Prompt capture: prompts and responses sent to ingest for session grouping (always on)
   - Gateway routing: requests flow through Optra for budget enforcement and guardrails (only if enabled)

5. **Session state:** Read `${CLAUDE_PLUGIN_DATA}/session-state.json` for current turn count and session duration.

Available commands:
- `/prism:setup` — Configure API key and gateway routing
- `/prism:cost` — Session cost summary
- `/prism:score` — Prompt quality tips
- `/prism:recommend` — Optimization advice
