# Optra Prism — Claude Code Plugin

PRISM intelligence plugin for Claude Code. Reviews prompts in real-time, captures telemetry for dashboard analytics, and tracks session costs.

## Requirements

- **Node.js 18+** (required for native `fetch`)
- **Claude Code** with plugin support
- A Prism API key — sign up at [Optra Prism](https://www.optra-prism.com)

### Claude Code compatibility

Claude Code 2.1.161+ is required for core telemetry and Score v3 support. Claude Code 2.1.196+ supports full prompt correlation (a reviewed declarative boundary, not a runtime semver gate). Older versions remain best-effort and are not blocked from ingest.

| Capability | Claude Code boundary | Fallback when unavailable |
|------------|----------------------|---------------------------|
| Stop response capture | 2.1.47+ | Skip Hook response capture |
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
/prism:setup YOUR_API_KEY

# 4. Restart Claude Code for OTEL telemetry to take effect
```

## What It Does

Four hooks run automatically:

| Hook | Purpose |
|------|---------|
| **SessionStart** | Loads Prism runtime configuration without modifying Claude settings |
| **UserPromptSubmit** | Reviews prompts for specificity/scope and captures them to ingest for scoring |
| **CwdChanged** | Refreshes sanitized Git repository metadata when the runtime supplies a valid working-directory change |
| **Stop** | Captures prompt/response pairs for analytics, tracks turns, and relays the server-side PRISM realtime score |

## Commands

| Command | Description |
|---------|-------------|
| `/prism:setup KEY` | Configure API key and enable telemetry in the installed plugin scope |
| `/prism:config` | Show or update Prism runtime configuration |
| `/prism:status` | Show read-only configuration, connection, and session status |
| `/prism:report` | Weekly review — this week vs last week, PRISM grade, habits, worst prompts |
| `/prism:help` | List all available commands |
| `/prism:uninstall` | Remove plugin config and OTEL settings |

## Configuration

`~/.prism/config.json` is the sole authority for Prism runtime configuration. Prism does not read runtime values from environment variables or plugin Configure options.

`/prism:setup KEY` sends the non-empty key to the config endpoint, stores the key and resolved service URLs in that file, and projects OTEL values to the settings file for the installed plugin scope:

- user: `~/.claude/settings.json`
- project: `<project>/.claude/settings.json`
- local: `<project>/.claude/settings.local.json`

Settings are read in user → project → local order, with later values taking precedence. Setup writes only the installed scope and does not move or delete values from another settings layer.

Use `/prism:config` to list the user-editable fields, their current values, accepted values, and apply behavior. The public configuration fields are:

| Field | Type | Default | Applies |
|-------|------|---------|---------|
| `show_realtime_summary` | boolean (`true` or `false`) | `false` | Next hook invocation |
| `ingest_url` | HTTPS URL, or HTTP on loopback | unset | Claude Code restart |

Use `/prism:config set <field> <value>` to update a field, `/prism:config unset <field>` to remove it, and `/prism:config help` for the complete field reference. The API key is managed separately with `/prism:setup KEY`.

After updating from v0.6.1 or earlier, run `/prism:setup KEY` once when `/prism:status` shows the API key or `ingest_url` as missing. This includes installations whose service URLs existed only in the legacy config cache, environment variables, or plugin Configure options.

## How It Works

```
/prism:setup KEY
    │
    ├─→ Calls config endpoint → resolves URLs from API key
    ├─→ Writes ~/.prism/config.json
    └─→ Syncs OTEL values to the installed-scope settings file

Claude Code starts
    │
    ├─→ Reads installed-scope settings → OTEL env vars set at process init
    ├─→ SessionStart hook → reads ~/.prism/config.json
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

Debug output is written to `$CLAUDE_PLUGIN_DATA/debug.log` when Claude Code provides that storage context. Otherwise, it is written to `~/.prism/logs/debug.log`.

## Auto-Updates

When installed via marketplace, the plugin updates automatically when a new version is released. You'll see a notification on session start when an update is applied.

## License

MIT
