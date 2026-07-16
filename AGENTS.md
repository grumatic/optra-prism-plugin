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

## Release Projection

- Treat promotion from `develop` to a release branch or `main` as a file/hunk projection, not commit transport.
- Never merge, rebase, or cherry-pick a `develop` commit into a release branch or `main`, even when its subject describes only a feature.
- Create each release branch from the current `main`, copy only the approved distribution file/hunk changes, and create new signed conventional commits on the release branch.
- Exclude development-only content from release branches and `main`, including `.github/`, `AGENTS.md`, `CLAUDE.md`, `test/`, and test/development scripts or tooling in `package.json`.
- If a `develop` commit or file mixes distribution and development changes, select only the distribution hunks. Never copy the whole commit or file merely for convenience.
- Apply release metadata (`CHANGELOG.md` and synchronized version fields) as the final, separate release commit after all approved feature projections.
- Before handoff, compare the release candidate with both `main` and the corresponding `develop` release state. Every difference must be either an approved distribution change or an explicitly excluded development-only change.

## Implementation

- Use conventional commits with subjects that state implementation facts only.
- Keep each logical change reviewable and separate from release metadata.
- Add or update tests for behavior changes on the development branch.
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
