# Changelog

All notable changes to the Prism plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
