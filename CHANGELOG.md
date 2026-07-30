# Changelog

All notable changes to the Prism plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.3] - 2026-07-31

### Fixed
- Command descriptions no longer include a manual `(prism)` source label, preventing current Claude Code versions from rendering `(prism)(prism)` while leaving the host-managed `prism:` command namespace unchanged.

## [0.7.2] - 2026-07-31

### Changed
- Every user-invocable command now keeps a lightweight main-context controller while delegating execution to a bounded foreground Haiku agent. Agent and Bash progress remain visible, then the command output is emitted as the final assistant response without appended agent metadata. Explicit Prism slash commands pre-authorize only their deterministic plugin entrypoint shapes, including validated setup, configuration, and confirmed-uninstall actions, so the plugin does not ask separately for Bash approval.
- Command frontmatter now declares unqualified names so current Claude Code applies the `prism:` plugin namespace exactly once. Descriptions start with `(prism)` so commands remain identifiable on older hosts that do not add the plugin namespace.

### Fixed
- Assistant-response OTEL events are collected again on Claude Code versions that inherit response logging from `OTEL_LOG_USER_PROMPTS`. Prism no longer projects `OTEL_LOG_ASSISTANT_RESPONSES=0`, and activation removes that legacy value only when the surrounding OTEL settings still match Prism's projection; standalone or diverged opt-outs are preserved.

## [0.7.1] - 2026-07-27

### Added
- Prism now tracks its own updates. SessionStart compares the installed version against the published marketplace manifest at most once every 24 hours, using a conditional `If-None-Match` request and a durable cache written atomically with mode 0600. Every failure keeps the last known good value and stays silent. Activation and latest-version notices are combined into one deterministic startup message, and the first prompt after a plugin reload recommends a restart.
- OTEL request headers are produced by a Prism-managed helper installed at `CLAUDE_PLUGIN_DATA/bin` with mode 0700 and registered as `otelHeadersHelper` in the install-scope settings file. The helper is self-contained and re-reads `~/.prism/config.json` and the active-version marker on every invocation, so a host that has not restarted can still pick up a refreshed key and plugin version.
- `/prism:status` and `/prism:doctor` report managed helper state: the disk-effective setting and its source, the expected path, and per-property artifact checks (existence, regular file, not a symlink, safe path chain, ownership, exact mode 0700, executable, bundled bytes). A helper owned by another setting is preserved and reported as a conflict instead of being overwritten.
- Every user-invocable command runs in its own fully namespaced forked agent with only the tools that command needs.
- `/prism:setup` seals the API key to the ingest destination the config endpoint declared for that key. Changing `apiKey` or `ingest_url` on its own — by hand, with `/prism:config`, or by pointing an existing key at another environment — is detected locally with no network round trip: hook requests stop at their existing not-configured skip, the OTEL headers helper refuses to emit headers, the OTEL projection refuses to write the pair so `/prism:config set ingest_url` reports the failure instead of aiming the old key at a new destination, SessionStart names the verified host and the current one, and `/prism:doctor` fails its API key check with the same detail. A config with no seal is unbound and fails open, so installs that predate this release keep working until their next `/prism:setup`.
- `/prism:doctor` reports enabled debug logging and the file hook diagnostics append to. Debug has no `/prism:config` field, so the toggle stays unadvertised while an install that quietly accumulates logs remains discoverable. Nothing is printed when it is off.

### Changed
- `/prism:uninstall` is a deterministic entrypoint instead of inline shell in the command file. Preview is read-only and emits a plan token bound to the resolved scope, registry, settings, and OTEL projection. Applying requires that exact token, re-verifies every input immediately before each mutation, aborts without side effects on any drift, and removes only validated Prism-owned targets. Remaining installs keep their registry entries, shared config, data, and cache.
- Uninstall removes the OTEL headers helper only when the path matches the Prism-managed one, and preserves a diverged value together with the file it references.
- `apiKey` and `dashboard_url` are registered in the shared config field registry, so they carry defaults and source attribution while staying out of `/prism:config` and `/prism:help`. `prismThreshold`, which no version after 0.6.1 reads, is dropped from `~/.prism/config.json` on the next write; unknown fields are still preserved.
- The detached model-catalog refresh reads `ingest_url` from `~/.prism/config.json` instead of receiving it through a `PRISM_CATALOG_INGEST_URL` environment variable. No runtime file now takes a configurable value from the environment; the remaining reads are host-provided paths and the plugin root handed to inline children.

### Fixed
- Commands no longer pre-authorize wildcard Node or Bash invocations. Each command pre-authorizes exactly one fixed inline entrypoint, mutating commands never pre-authorize a mutation or a dynamic matcher, and command output is relayed without interpolating user arguments into inline shell.

## [0.7.0] - 2026-07-24

### Changed
- Response costs now use an ingest-provided model catalog cached per resolved environment instead of a plugin-local price table. Stop hooks price exact model IDs at each usage record's timestamp from the last-known-good catalog without network I/O.
- Cost reporting fails closed for unknown, ambiguous, or unpriced models, invalid timestamps, unproven cache-write TTLs, and incomplete usage. Numeric costs are sent only with their catalog revision and public-list-price provenance; unavailable costs render as `cost n/a`.

### Fixed
- Prompt responses are delivered through a durable on-disk outbox that retries until the server confirms receipt, so a response is no longer lost when a single delivery attempt fails (network error, restart, or an interrupted hook). Delivery is idempotent, so retries never record a response more than once.

## [0.6.3] - 2026-07-23

### Added
- `/prism:config` and `/prism:help` now enumerate every user-editable field with its current or default value, type, accepted values, apply behavior, and exact `set`/`unset` usage from one shared field registry.
- Unsupported config fields now report the available field names, while API-key changes direct users to `/prism:setup KEY`.

### Changed
- The public realtime-summary field is now consistently named `show_realtime_summary` alongside `ingest_url`. Existing `showRealtimeSummary` values remain readable and migrate to the canonical field on the next config write.
- `/prism:config` now uses explicit `show`, `help`, `set <field> <value>`, and `unset <field>` actions.
- The README now links to the official Optra Prism website and removes the unavailable domain-hosted shell installer instructions.

## [0.6.2] - 2026-07-20

### Added
- `/prism:config` for displaying and updating the two user-editable runtime values: `showRealtimeSummary` and `ingest_url`. Removing `ingest_url` also removes Prism-managed OTEL values from the installed plugin scope and reports any values still owned by another settings layer.
- Source-aware `/prism:status` diagnostics for config values and effective on-disk OTEL settings, including the owning `user`, `project`, or `local` layer and the HTTP evidence returned by the ingest health endpoint.

### Changed
- `~/.prism/config.json` is the sole Prism runtime configuration authority. Prism environment overrides, native plugin Configure options, and the legacy config cache no longer participate in runtime resolution.
- `/prism:setup KEY` treats every non-empty key as opaque and lets backend `401`/`403` responses determine authentication failure. Successful setup stores the resolved service URLs and projects OTEL settings only to the detected install scope.
- Claude settings are resolved per key in `user → project → local` order. Setup and config writes do not move, delete, or repair another scope automatically.
- SessionStart reads and reports config state without fetching config, rewriting Claude settings, or exporting Prism environment variables.
- Users updating from v0.6.1 or earlier must run `/prism:setup KEY` once when `/prism:status` reports a missing `apiKey` or `ingest_url`, including installations whose service URLs existed only in the legacy cache.

### Fixed
- `/prism:status` no longer reports OTEL logs or metrics as `not set` merely because the slash-command process did not inherit them; it reads the effective settings files directly.
- Setup, config, notification, health, and SessionStart failures retain their concrete HTTP, network, JSON, scope, or projection evidence instead of collapsing into generic configuration messages or false success.
- Ingest base URLs preserve a configured trailing slash without generating double-slash prompt, realtime, or report endpoints. Unsafe remote plaintext HTTP destinations, credentials, query strings, and fragments are rejected before credentials or captured data are sent; loopback HTTP remains supported for development.
- Opaque API keys are safely encoded in OTLP header lists, and settings overlay cannot treat inherited object properties as effective OTEL values.

### Removed
- Native plugin `userConfig`, Prism runtime environment overrides, config-cache routing, and the public `prismThreshold` no-op setting.
- SessionStart config refresh and `CLAUDE_ENV_FILE` mutation, plus automatic OTEL repair and cross-scope cleanup during setup or session startup.

## [0.6.1] - 2026-07-17

### Fixed
- `/prism:*` commands resolve their entrypoint with the `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SESSION_ID}` substitutions instead of `$PLUGIN_DIR` / `$CLAUDE_CODE_SESSION_ID`, which never resolved — the previous forms broke the command path and triggered a shell-expansion permission prompt.
- `/prism:realtime` reads the correct runtime session directory: it passes the plugin data dir explicitly (command context can inherit another plugin's `CLAUDE_PLUGIN_DATA`), and the fallback data location is the installed plugin data dir rather than `~/.prism`.
- `/prism:realtime` falls back to the most recent session with completed turns, not merely the newest session directory (which may be an empty session created by slash commands only).

### Removed
- The Stop-hook context nudge and its context-token tracking (`firstInputTokens` / `lastInputTokens` / `responseTimes`); the plugin no longer estimates context health, which the editor status line already reports.

## [0.6.0] - 2026-07-17

### Added
- Server-side PRISM score in the Stop-hook summary and `/prism:realtime`: the current session's most recent scored sub-session is fetched from ingest and rendered with its state (`live`/`settled`), intent, goal/rework markers, and turn range.
- `/prism:realtime` session detail listing per-sub-session grade, state, intent, and turn range, plus a Today activity narrative from the server.

### Changed
- The Stop-hook summary now relays the real server PRISM grade instead of a locally computed heuristic; the grade shown always originates from the server.
- `showRealtimeSummary` now defaults to **off**; the score line is opt-in via the option or `~/.prism/config.json`.
- Slash commands compute and render their output in deterministic script entrypoints; command prompts only display the result. Read-only commands pre-authorize their entrypoint to avoid repeated permission prompts.
- `/prism:setup` performs API-key validation, config writes, scope sync, and dashboard notification in a single script call; the key is passed only through the process environment.

### Removed
- Local "Lite" session-hygiene grade, the context-usage percentage, and the hardcoded context-window estimate from the summary line.

## [0.5.1] - 2026-07-17

### Added
- `/prism:realtime` command printing the current session's turn summary and token detail on demand, for hosts that render no hook `systemMessage` output (VS Code panel).
- `showRealtimeSummary` option controlling realtime summary display while capture continues.
- Sanitized repository metadata (host/owner/repo, branch, head commit, dirty state, worktree flag) attached to prompt capture.

### Changed
- Stop hook emits correlated turn summaries authorized by transcript turn proof; token and cost figures derive from transcript usage records.
- Prompt-submission user-facing output is routed through the documented hook JSON channel.

### Deprecated
- `showStatusLine` no longer has any effect; use `showRealtimeSummary` instead.

### Removed
- One-turn-delayed status line and legacy shared session state.

## [0.5.0] - 2026-07-16

### Added
- Validated ingest base overrides through `PRISM_INGEST_URL` and `~/.prism/config.json.ingest_url`.
- Plugin version provenance on config, hook, and OTLP requests.
- Prism API key support with legacy `gck_*` compatibility.
- Claude Code compatibility boundaries for individual plugin and OTEL capabilities.

### Changed
- Claude Code connection settings are no longer modified by the plugin.
- Assistant response logging is disabled in generated OTEL settings.
- API keys are passed to setup helpers through the process environment.
- Rejected credentials are handled separately from transient config endpoint failures.

### Removed
- Gateway routing opt-in (`enableGateway`); API calls are never routed through the Optra gateway.

## [0.4.9] - 2026-05-27

### Changed
- **Domain migration to optra-prism.com** — homepage and author URLs in `plugin.json` and `package.json` now point at `optra-prism.com`; description references `dashboard.optra-prism.com`.

## [0.4.8] - 2026-05-26

### Added
- **`/prism:doctor` diagnostic command** — new slash command runs 5 deterministic checks (API key, OTEL scope, config cache health, ingest connectivity, process env sync) and prints a structured report. Auto-fixes stale/fallback config cache via `fetchConfig()`. New `lib/doctor.js`; `session-start.sh` now recommends `/prism:doctor` on scope-skip and sync-failure paths.

### Fixed
- **Uninstall no longer zombie-resurrects** — scope-aware cleanup so user-scope uninstall only removes user entries, local only removes current-project entries; other-scope installs are preserved independently. New `cleanupRegistries()` in `lib/settings.js` handles `installed_plugins.json`, `enabledPlugins`, and OTEL vars per scope. Marketplace registration is no longer removed by uninstall (it's a source registry). Hook HTTP timeout reduced 10s → 3s so unreachable ingest doesn't look like zombie behavior. Remaining installs in other scopes are reported after cleanup.
- **OTEL scope resolution centralized** — replaced 3 independent scope-detection chains (each with a `user` wildcard fallback) with a single `resolveOtelScope()`. When install scope is unknown, OTEL writes are refused instead of defaulting to user scope. Auto-repairs misplaced OTEL vars when install scope is definitively known. Root cause: `install.sh` ran without `--project-dir` in curl-pipe contexts, so `process.cwd()` never matched any `projectPath`, falling back to user — then `session-start.sh` perpetuated it via a self-reinforcing loop.
- **OTEL preserves project paths with spaces** — quoting fix in scope resolution / OTEL var writes.

## [0.4.7] - 2026-05-07

### Added
- **Setup-completion ping** — `/prism:setup` now POSTs `/v1/setup-complete` to ingest at the tail of the command. Lets the dashboard's activation page transition from "Waiting for /prism:setup…" to "Key configured. Quit and restart Claude Code, then send a prompt." the moment the slash command finishes, instead of waiting for the first prompt to arrive. Best-effort: failures (no network, ingest unreachable) are swallowed so `/prism:setup` never breaks. New helper at `lib/notify.js`.

## [0.4.6] - 2026-05-01

### Fixed
- **Install-scope detection on first session** — `lib/settings.js` `detectInstallScope()` now reads `~/.claude/plugins/installed_plugins.json` instead of `enabledPlugins` in settings files. Claude Code writes `enabledPlugins` *after* the session-start hook fires, so the previous lookup always returned `null` on the very first session and OTEL env vars were written to user scope even for project/local installs. The new logic returns `user` when any entry has `scope=user`, otherwise matches the current project path.

## [0.4.5] - 2026-04-29

### Changed
- **`/prism:report` rewritten** — single weekly-review command that compares **this week vs last week** using **day-aligned** windows (Mon→same-day-of-week-as-now, equal elapsed days) so totals don't bias against the in-progress week.
- **PRISM scoring is spec-canonical** (`prism-scoring-spec.md` §7): `0.50·Skill_10 + 0.30·Efficiency_10 + 0.20·Speed_10` computed from `skillSnapshot` when the engine has populated Layer 2/3. Falls back to `prismProfile.compositeScore` (rubric proxy) and labels it explicitly when Layer 3 isn't ready.
- **One-metric headline** — drop the PromptIQ rubric (CL/ID/TE/AC) bars from user-facing output. The rubric is still used silently to pick a coaching tip.
- **Grade rendering matches the dashboard** — 10-tier ladder from `apps/dashboard/src/lib/prism-colors.ts` `GRADE_BANDS` (B = 7.0–7.9 baseline), `[from, to)` half-open intervals.
- **Token usage chart** — new section aggregates Input / Output / CacheR / CacheW from `/v1/telemetry/logs` (`event_name === 'api_request'`) with per-row Δ vs last week and tokens/turn signal.
- **Gateway routing default flipped to OFF** — Claude Code calls Anthropic directly out of the box. Telemetry and PRISM scoring still work. Run `/prism:status` to enable budget enforcement, guardrails, and usage logging.
- **Marketplace description rewritten** — "AI vibe coding intelligence for Claude Code — realtime coaching, PRISM scoring, insights, and gateway routing. Pairs with dashboard.prism.optra-ai.com". Keywords updated to reflect the broader feature set (vibe-coding, realtime-coach, prism-score, insights).
- **`/prism:uninstall` now sweeps all three scopes** — user (`~/.claude/settings.json`), project-shared (`<project>/.claude/settings.json`), and project-local (`<project>/.claude/settings.local.json`). New `--scope all` value in `lib/settings.js` (`both` kept as legacy alias).
- **Empty-section behavior** — `/prism:report` skips Coaching and Cost optimization sections entirely when there's no data, rather than rendering "No data this period" placeholders.
- All commands end with a CTA pointing users at the dashboard.

### Removed
- `/prism:score` command (merged into `/prism:report`).
- `/prism:cost` command (replaced by the Token usage section in `/prism:report`).
- Unused engine helpers `fetchReport()` and `generateReport()` from `lib/engine.js` — only `quickReport()` and `fetchTelemetryLogs()` are exported now.
- Generic fallback coaching block ("cut filler / be concrete / one ask per turn") that surfaced when `prismProfile.coaching[]` was empty.
- `firstTryRate` and `frictionRate` rows from `/prism:report` — no longer tracked here.

### Fixed
- `lib/engine.js` — `quickReport({ from, to })` now accepts ISO date-range params and forwards them to the engine via the `post()` helper's new `query` argument. Required for the day-aligned weekly comparison.
- `commands/uninstall.md` reinstall hint corrected from `/plugin install prism@optra-prism` to `/plugin install prism`.

## [0.4.3] - 2026-04-23

### Fixed
- `commands/uninstall.md` — PLUGIN_ROOT discovery now also checks `~/.prism/claude-code-plugin/`, so manual-install users get OTEL vars pruned from `settings.json` before the cache is wiped
- `install.sh` — corrected misleading "Gateway routing is disabled by default" message (config writes `enableGateway: true`)
- `install.sh` — sync now respects existing scope via `detect`; previously a re-run of the curl installer over a `--project` setup would duplicate OTEL vars into user scope
- `package.json` — `files[]` now matches what's on disk (added `commands/`, `install.sh`; removed nonexistent `skills/`)

### Changed
- `commands/setup.md` and `install.sh` — wipe `~/.prism/config-cache.json` before writing a new key, so URLs are re-fetched fresh on every setup
- `commands/uninstall.md` — final message reminds users to re-run uninstall in any other repo where project-scope was used (cross-project cleanup is not automatic)

## [Unreleased]

### Added
- `lib/config.js` — config endpoint client with 24h cache at `${CLAUDE_PLUGIN_DATA}/config-cache.json`

### Changed
- URL resolution via config endpoint (`ingest.prism.optra-ai.com/v1/plugin/config`) — no hardcoded environment URLs in plugin source
- Removed `environment` from userConfig (server resolves from API key)
- `lib/env.js` reads URLs from config cache instead of hardcoded `DEFAULTS` object
- `lib/settings.js` reads ingest URL from config cache instead of `URL_DEFAULTS`
- `session-start.sh` resolves URLs from config cache instead of `case PRISM_ENV` block
- Only `PRISM_INGEST_URL` env var override allowed; gateway/dashboard URLs always from config endpoint

## [0.1.0] - 2026-04-02

### Added
- Initial release as standalone plugin repo
- Marketplace distribution via `grumatic/optra-prism-plugin`
- Native `userConfig` support (API key stored in system keychain)
- Gateway routing opt-in via `enableGateway` setting
- Real-time prompt quality scoring with configurable threshold
- OTEL telemetry export (logs, metrics, traces)
- Session cost and token usage tracking
- PRISM score integration (6-dimension framework)
- 6 slash commands: `/prism:setup`, `/prism:status`, `/prism:cost`, `/prism:score`, `/prism:recommend`, `/prism:uninstall`
- Prism Advisor skill for prompt optimization guidance
- SessionStart, UserPromptSubmit, and Stop lifecycle hooks
- Version update notification on session start
- CI/CD: validation workflow (PR/push) and release workflow (tag)
