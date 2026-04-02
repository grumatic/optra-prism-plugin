#!/bin/bash
# ─── Bump plugin version across all manifests ───
# Usage: ./scripts/bump-version.sh 0.2.0

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.2.0"
  exit 1
fi

VERSION="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: Invalid semver format: $VERSION"
  exit 1
fi

echo "Bumping version to ${VERSION}..."

# Update .claude-plugin/plugin.json
node -e "
  const fs = require('fs');
  const f = '${ROOT}/.claude-plugin/plugin.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = '${VERSION}';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('  Updated .claude-plugin/plugin.json');
"

# Update package.json
node -e "
  const fs = require('fs');
  const f = '${ROOT}/package.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.version = '${VERSION}';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('  Updated package.json');
"

# Update .claude-plugin/marketplace.json
node -e "
  const fs = require('fs');
  const f = '${ROOT}/.claude-plugin/marketplace.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (j.plugins && j.plugins[0]) j.plugins[0].version = '${VERSION}';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  console.log('  Updated .claude-plugin/marketplace.json');
"

echo ""
echo "Version bumped to ${VERSION}. Next steps:"
echo "  1. Update CHANGELOG.md"
echo "  2. git add -A && git commit -m 'release: v${VERSION}'"
echo "  3. git tag v${VERSION}"
echo "  4. git push origin main --tags"
