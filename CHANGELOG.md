# Changelog

All notable changes to the Prism plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
