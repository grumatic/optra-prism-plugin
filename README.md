# Optra Prism — Claude Code Plugin

PRISM intelligence plugin for Claude Code. Reviews prompts in real-time, captures telemetry for dashboard analytics, and tracks session costs.

## Requirements

- **Node.js 18+** (required for native `fetch`)
- **Claude Code** with plugin support
- A Prism API key — sign up at [optra-ai.com](https://optra-ai.com)

### Claude Code compatibility

Claude Code 2.1.161+ is required for core telemetry and Score v3 support. Claude Code 2.1.196+ supports full prompt correlation (a reviewed declarative boundary, not a runtime semver gate). Older versions remain best-effort and are not blocked from ingest.

| Capability | Claude Code boundary | Fallback when unavailable |
|------------|----------------------|---------------------------|
| Stop response capture | 2.1.47+ | Skip Hook response capture |
| Native Plugin `userConfig` | 2.1.83+ | Use environment or local config |
| Working-directory change hook | 2.1.83+ (conservative changelog-inferred floor) | Runtime shape-gate and submit-time refresh |
| OTEL tool correlation | 2.1.119+ | Disable direct tool correlation |
| Numeric OTEL attributes | Format changes in 2.1.122 | Accept both string and number values |
| Core telemetry and Score v3 | 2.1.161+ | Continue raw ingest as best-effort |
| Native assistant response | 2.1.193+ | Disable response-aware analysis |
| Exact prompt correlation | 2.1.196+ | Use legacy session-order fallback |

## Quick Start

```bash
# 1. Add the marketplace
/plugin marketplace add grumatic/optra-prism-plugin

# 2. Install the plugin
/plugin install prism@optra-prism

# 3. Configure your API key
/prism:setup prism_YOUR_API_KEY

# 4. Restart Claude Code for OTEL telemetry to take effect
```

### Alternative: Shell installer

```bash
curl -sL https://optra-ai.com/install-plugin.sh | bash -s -- prism_YOUR_KEY
```

## What It Does

Four hooks run automatically:

| Hook | Purpose |
|------|---------|
| **SessionStart** | Validates API key and configures OTEL telemetry |
| **UserPromptSubmit** | Reviews prompts for specificity/scope and captures them to ingest for scoring |
| **CwdChanged** | Refreshes sanitized Git repository metadata when the runtime supplies a valid working-directory change |
| **Stop** | Captures prompt/response pairs for analytics, tracks turns, warns on context bloat |

## Commands

| Command | Description |
|---------|-------------|
| `/prism:setup` | Configure API key, enable telemetry |
| `/prism:status` | Connection health, realtime summary setting, session info |
| `/prism:report` | Weekly review — this week vs last week, PRISM grade, habits, worst prompts |
| `/prism:help` | List all available commands |
| `/prism:uninstall` | Remove plugin config and OTEL settings |

## Configuration

Service URLs are resolved automatically from your API key via the config endpoint (`https://ingest.optra-prism.com/v1/plugin/config`). For local development, the ingest URL can be overridden with `PRISM_INGEST_URL`:

```bash
PRISM_INGEST_URL=http://localhost:9005 claude
```
### Realtime summary

`showRealtimeSummary` is enabled by default. The effective value is resolved in this order:

1. `CLAUDE_PLUGIN_OPTION_SHOWREALTIMESUMMARY`
2. `CLAUDE_PLUGIN_OPTION_showRealtimeSummary` (compatibility name)
3. Own-property `showRealtimeSummary` in `~/.prism/config.json`
4. Default `true`

Only boolean values and the exact strings `true` / `false` are accepted. An invalid selected source uses the safe default instead of falling through. A legacy config change is masked by either environment source and must not be treated as changing the active setting. `showStatusLine` is deprecated and has no effect on this setting.

## How It Works

```
/prism:setup prism_KEY
    │
    ├─→ Calls config endpoint → resolves URLs from API key
    ├─→ Caches config locally
    └─→ Syncs OTEL env vars to ~/.claude/settings.json (global)

Claude Code starts
    │
    ├─→ Reads ~/.claude/settings.json → OTEL env vars set at process init
    ├─→ SessionStart hook → validates key and checks OTEL settings
    │
    ├─→ User types prompt
    │   └─→ UserPromptSubmit hook → captures prompt to ingest
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
