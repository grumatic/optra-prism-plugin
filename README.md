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
| OTEL telemetry from project and local settings | Ignored from 2.1.282 | Install at user scope; project and local installs capture prompts without OTEL telemetry |

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

Five hooks run automatically:

| Hook | Purpose |
|------|---------|
| **SessionStart** | Activates version metadata, checks for a newer stable release, and loads Prism runtime configuration |
| **UserPromptSubmit** | Detects a reloaded plugin version, then reviews and captures prompts for scoring |
| **CwdChanged** | Refreshes sanitized Git repository metadata when the runtime supplies a valid working-directory change |
| **PostToolUse (SendMessage)** | Captures successful agent-to-agent send evidence without storing the message body |
| **Stop** | Captures prompt/response pairs for analytics, tracks turns, and relays the server-side PRISM realtime score |

Prompt capture uses a legacy correlation fallback only when an older host omits
`prompt_id`. A host that explicitly supplies an invalid `prompt_id` is rejected
without enqueueing a prompt.

## Commands

| Command | Description |
|---------|-------------|
| `/prism:setup KEY` | Configure API key and enable telemetry in the installed plugin scope |
| `/prism:config` | Show or update Prism runtime configuration |
| `/prism:status` | Show read-only configuration, connection, and session status |
| `/prism:report` | Weekly review — this week vs last week, PRISM grade, habits, worst prompts |
| `/prism:help` | List all available commands |
| `/prism:uninstall` | Preview and remove the current install scope |

## Configuration

`~/.prism/config.json` is the sole authority for Prism runtime configuration. Prism does not read runtime values from environment variables or plugin Configure options.

`/prism:setup KEY` sends the non-empty key to the config endpoint, stores the key and resolved service URLs in that file, and projects OTEL values to the settings file for the installed plugin scope:

- user: `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when `CLAUDE_CONFIG_DIR` is set to an absolute path (`~` is not expanded)
- project: `<project>/.claude/settings.json`
- local: `<project>/.claude/settings.local.json`

Claude Code also moves its `plugins/` tree under `CLAUDE_CONFIG_DIR`; Prism follows it. `CLAUDE_CODE_PLUGIN_CACHE_DIR` is not supported: the installer, setup, config, and uninstall refuse while it is set, and `/prism:status` and `/prism:doctor` report it. Setup, config, uninstall, and activation also refuse when the plugin root or plugin data directory does not match the config directory Claude Code installed the plugin under; `/prism:status` and `/prism:doctor` show the config directory and that check. `~/.prism` stays under your home directory and is shared by every config directory.

Settings are read in user → project → local order, with later values taking precedence. Setup writes only the installed scope and does not move or delete values from another settings layer.

Claude Code 2.1.282 and later ignore telemetry variables in project and local settings; those layers can only turn telemetry off.
On such a host, a project or local install sends no OTEL telemetry: setup writes no OTEL values there, removes the values Prism wrote earlier, and reports that telemetry is not collected.
Prompt and hook capture continue.
To collect telemetry, uninstall the project or local install, install Prism at user scope, and run `/prism:setup KEY` again.

A user-scope install collects telemetry in every project.
To run one session without Prism, pass the settings file that setup writes to the plugin data directory:

```bash
claude --settings ~/.claude/plugins/data/prism-optra-prism/prism-off.settings.json
```

That file disables the plugin and turns OTEL export off for that session only; `/prism:status` shows its exact path.

Setup also installs a self-contained OTEL headers helper under the plugin data
directory and records its absolute path in the same settings scope. The static
OTEL header remains the immediate restart path. The helper refreshes the API key
and plugin-version headers on Claude Code's helper schedule for users who defer
the restart. Prism preserves an unrelated `otelHeadersHelper` instead of
overwriting it; `/prism:status` and `/prism:doctor` report that conflict.

Use `/prism:config` to list the user-editable fields, their current values, accepted values, and apply behavior. The public configuration fields are:

| Field | Type | Default | Applies |
|-------|------|---------|---------|
| `show_realtime_summary` | boolean (`true` or `false`) | `false` | Next hook invocation |
| `ingest_url` | HTTPS URL, or HTTP on loopback | unset | Claude Code restart |

Use `/prism:config set <field> <value>` to update a field, `/prism:config unset <field>` to remove it, and `/prism:config help` for the complete field reference. The API key is managed separately with `/prism:setup KEY`.

After updating from v0.6.1 or earlier, run `/prism:setup KEY` once when `/prism:status` shows the API key or `ingest_url` as missing. This includes installations whose service URLs existed only in the legacy config cache, environment variables, or plugin Configure options.

## Uninstall

`/prism:uninstall` previews, then removes, the Prism install for the current Claude config directory only: its registry entry, settings, plugin data, and plugin cache. It never writes to or deletes anything inside another config directory.

`~/.prism` (API key, config, binding) is shared by every config directory. Prism records each config directory where it has been seen in `~/.prism/installs.json`, which holds paths and timestamps only and keeps at most 32 directories. Uninstall reads the registry of every recorded directory, and of `~/.claude`, and keeps `~/.prism` when:

- another directory still has a Prism install, or its registry cannot be verified;
- the inventory is corrupt, or is full and some directories were not recorded.

The preview and the result name the directories or the inventory condition that kept it, and apply checks again immediately before removing `~/.prism`. `/prism:status` and `/prism:doctor` list the other directories and their state.

A session started with `--plugin-dir` is not recorded in `installed_plugins.json`. A config directory used only that way is recorded, then verifies as absent, so it does not protect `~/.prism`.

## How It Works

```
/prism:setup KEY
    │
    ├─→ Calls config endpoint → resolves URLs from API key
    ├─→ Writes ~/.prism/config.json
    ├─→ Syncs OTEL values to the installed-scope settings file
    └─→ Installs the stable OTEL headers helper in plugin data

Claude Code starts
    │
    ├─→ Reads installed-scope settings → OTEL env vars set at process init
    ├─→ SessionStart hook → activates version metadata and checks for updates
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

On `SessionStart(startup)`, Prism checks the public marketplace metadata at most
once every 15 minutes and reuses a last-known-good cache on network or parse
failure. When a newer stable version is available, the session message tells
you to update the plugin, then run `/reload-plugins` or restart Claude Code.

After a new plugin version is activated, the first SessionStart or subsequent
UserPromptSubmit updates the static plugin-version header and, when no unrelated
helper conflicts, the stable helper. A helper that was already registered
refreshes the plugin-version header on Claude Code's helper schedule, so no
restart message is shown for a version change alone. A restart message appears
only for changes Claude Code reads at launch: a newly registered helper, a
static header that is the only header source, or a changed OTEL environment
value. An activation failure is reported once per session.

## License

MIT
