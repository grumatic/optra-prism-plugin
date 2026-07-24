# AGENTS.md

Repository instructions for the Optra Prism Claude Code plugin.

## Scope

- Keep changes limited to the user's explicit request.
- Do not make unrelated wording, naming, formatting, or cleanup changes.
- Preserve existing working-tree changes that are outside the requested scope.
- Do not commit, push, tag, create a pull request, merge, rebase, amend, or rewrite branches unless the user explicitly requests that operation.

## Branch Roles

- `develop` is the development source of truth. Implement and test changes there.
- `main` is the public distribution branch consumed by Claude Code marketplace installs.
- Development-only setup such as `AGENTS.md` and `.github/` must not be promoted to `main`.
- Do not merge `develop` and `main` merely to reconcile their intentionally different trees.
- Promote only the explicitly approved feature changes from `develop` to a release candidate based on `main`.
- Do not rename, reset, rebase, or otherwise move candidate branches unless the user explicitly requests it.

## Release Pipeline

The development-to-release flow is fixed. Steps 1–3 are mandatory agent work rules. Steps 4–6 are optional follow-ups: run them only when the user requests them.

1. On `develop` (or a work branch), split main-bound feature changes into one commit per feature unit. Commit non-main-bound (development-only) changes with as little splitting as possible — batch them.
2. When the release candidate is scoped on `develop`, create the `release: vX.Y.Z` commit there (CHANGELOG section plus synchronized version fields).
3. Create the release branch from the current `main` and project the candidate in as few commits as possible, ending with the release commit.
4. (On request) Create the release-branch PR and merge it. `main` is governed by the "Release" ruleset: PR required, rebase merge only, linear history, no force-push or deletion.
5. (On request) Tag `vX.Y.Z` on the merged release commit at the tip of `main`.
6. (On request) Publish the GitHub Release for that tag, with notes derived from the tag's CHANGELOG section.

## Release Projection

- Treat promotion from `develop` to a release branch or `main` as a file/hunk projection, not commit transport.
- Never merge, rebase, or cherry-pick a `develop` commit into a release branch or `main`, even when its subject describes only a feature.
- Create each release branch from the current `main`, copy only the approved distribution file/hunk changes in as few commits as possible, and create new signed conventional commits on the release branch.
- Exclude development-only content from release branches and `main`, including `.github/`, `AGENTS.md`, `CLAUDE.md`, `test/`, agent runtime state directories (`.omc/`, `.omx/`, `.gjc/`, `.claude/`), and test/development scripts or tooling in `package.json`.
- Do not create mixed commits in the first place (see Implementation). If a legacy `develop` commit or file already mixes distribution and development changes, select only the distribution hunks during projection. Hunk selection is a recovery tool for legacy history, not a license to mix. Never copy the whole commit or file merely for convenience.
- Project release metadata (`CHANGELOG.md` and synchronized version fields, as created by the `develop` release commit) as the final, separate release commit.
- Before handoff, compare the release candidate with both `main` and the corresponding `develop` release state. Every difference must be either an approved distribution change or an explicitly excluded development-only change.

## Implementation

- Use conventional commits with subjects that state implementation facts only.
- Split main-bound changes into one commit per feature unit; keep each separate from release metadata and from development-only changes.
- Never mix distribution files (`lib/`, `hooks/`, `commands/`, `agents/`, `.claude-plugin/`, `README.md`, `install.sh`, distribution fields of `package.json`) and development-only files (`test/`, `.github/`, `AGENTS.md`, `CLAUDE.md`, dev tooling in `package.json`) in one commit. Commit-level separation is what makes release projection auditable.
- Commit development-only changes (tests, workflows, agent docs, dev tooling) with as little splitting as possible: batch them rather than pairing one development commit per feature. Add or update tests for behavior changes on the development branch.
- Never commit agent or editor runtime state (`.omc/`, `.omx/`, `.gjc/`, `.claude/`, session or memory files). If such files appear as untracked, leave them untracked.
- Preserve backward-compatible behavior unless the user explicitly approves a breaking change.

## Validation

Before handing off a development change, run the relevant checks:

```bash
npm test
for file in lib/*.js hooks/scripts/*.js; do node --check "$file"; done
node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json', 'utf8'))"
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate .claude-plugin/marketplace.json --strict
```

## Release Policy

- Releases are manual. Do not add tag-triggered release automation.
- `CHANGELOG.md` and version changes belong in a dedicated `release: vX.Y.Z` commit, not in feature commits.
- Keep versions identical in `package.json`, `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.
- The release commit must be present on `main` and pass validation before tagging.
- Create `vX.Y.Z` only on the exact release commit on `main`.
- Tag creation, tag push, and GitHub Release creation each require explicit user authorization.
- Never disable or bypass the configured commit-signing policy to complete a release.
