# Optra Prism — Claude Code Plugin

AI coding governance plugin for Claude Code. Scores prompt quality in real-time, captures telemetry for dashboard analytics, tracks session costs, and optionally routes requests through the Optra gateway for budget enforcement and guardrails.

## Requirements

- **Node.js 18+** (required for native `fetch`)
- **Claude Code** with plugin support
- An Optra API key (`gck_*`) — sign up at [optra-ai.com](https://optra-ai.com)

## Quick Start

```bash
# 1. Add the marketplace
/plugin marketplace add grumatic/optra-prism-plugin

# 2. Install the plugin
/plugin install prism@optra-prism

# 3. Configure your API key
/prism:setup gck_YOUR_API_KEY

# 4. Restart Claude Code for OTEL telemetry to take effect
```

### Alternative: Shell installer

```bash
curl -sL https://optra-ai.com/install-plugin.sh | bash -s -- gck_YOUR_KEY
```

## Modes

| Mode | What happens | Latency impact |
|------|-------------|----------------|
| **Telemetry only** (default) | OTEL export + prompt scoring + cost tracking. API calls go directly to Anthropic. | None |
| **Full governance** | All of the above, plus API calls route through Optra gateway for budget enforcement, guardrails, and full request/response logging. | Small hop |

Choose your mode during `/prism:setup`. You can change it anytime.

## What It Does

Three hooks run automatically:

| Hook | Purpose |
|------|---------|
| **SessionStart** | Validates API key, configures OTEL telemetry, optionally sets gateway routing |
| **UserPromptSubmit** | Scores prompt quality (blocks low-quality prompts with coaching tips), captures to ingest |
| **Stop** | Captures prompt/response pairs for analytics, tracks turns, warns on context bloat |

## Commands

| Command | Description |
|---------|-------------|
| `/prism:setup` | Configure API key, enable telemetry + gateway |
| `/prism:status` | Connection health, gateway toggle, session info |
| `/prism:cost` | Session cost, token usage |
| `/prism:score` | Weakest dimension, coaching tips, optimization advice |
| `/prism:report` | Full review — trends, habits, waste, worst prompts |
| `/prism:uninstall` | Remove plugin config and OTEL settings |

## Configuration

All service URLs (ingest, gateway, dashboard) are resolved automatically from your API key — no manual URL configuration needed. The plugin calls a config endpoint on setup and caches the result.

For local development, override with env vars:

```bash
PRISM_INGEST_URL=http://localhost:9005 PRISM_GATEWAY_URL=http://localhost:3003 claude
```

## How It Works

```
/prism:setup gck_KEY
    │
    ├─→ Calls config endpoint → resolves URLs from API key
    ├─→ Caches config locally
    └─→ Syncs OTEL env vars to ~/.claude/settings.json (global)

Claude Code starts
    │
    ├─→ Reads ~/.claude/settings.json → OTEL env vars set at process init
    ├─→ SessionStart hook → validates key, optionally sets gateway URL
    │
    ├─→ User types prompt
    │   └─→ UserPromptSubmit hook → scores PQ, captures to ingest
    │
    ├─→ Claude responds (OTel auto-exports: api_request, tool_result, etc.)
    │   └─→ Stop hook → captures response + turn counter
    │
    └─→ Next prompt...
```

## Team Distribution

Add Prism to all team members by committing to your project's `.claude/settings.json`:

```json
{
  "plugins": [
    {
      "source": "marketplace",
      "name": "grumatic/optra-prism-plugin"
    }
  ]
}
```

Each developer runs `/prism:setup` with their own API key.

## Debugging

```bash
# Tail debug log
tail -f ~/.claude/plugins/data/prism-inline/debug.log

# Enable debug output in session
PRISM_DEBUG=1 claude
```

## Auto-Updates

When installed via marketplace, the plugin updates automatically when a new version is released. You'll see a notification on session start when an update is applied.

## License

MIT
