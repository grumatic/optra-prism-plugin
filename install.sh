#!/bin/bash
# ─── Prism Plugin Installer ───
# Installs via Claude Code marketplace (preferred) or manual clone (fallback).
#
# Usage:
#   curl -sL https://optra-ai.com/install-plugin.sh | bash -s -- YOUR_KEY
#   curl -sL https://optra-ai.com/install-plugin.sh | bash   # configure key later

set -euo pipefail

MARKETPLACE_REPO="grumatic/optra-prism-plugin"
INSTALL_DIR="${HOME}/.prism/claude-code-plugin"
MIN_NODE_VERSION=18

API_KEY="${1:-}"

# ─── Helpers ───

info() { echo "[prism] $1"; }
error() { echo "[prism] ERROR: $1" >&2; exit 1; }

check_node() {
  if ! command -v node &>/dev/null; then
    error "Node.js is required but not installed. Install Node.js ${MIN_NODE_VERSION}+ and try again."
  fi

  local version
  version=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$version" -lt "$MIN_NODE_VERSION" ]; then
    error "Node.js ${MIN_NODE_VERSION}+ is required (found v${version}). Please upgrade and try again."
  fi
  info "Node.js v$(node -v | tr -d 'v') detected"
}

# ─── Main ───

info "Installing Prism plugin..."

check_node

# Prefer marketplace install if Claude Code CLI is available
if command -v claude &>/dev/null; then
  info "Installing via Claude Code marketplace..."

  # Force a clean reinstall: wipe ALL cached plugin source (every version),
  # wipe the plugin data dir, and drop the installed_plugins.json entry so
  # Claude Code doesn't short-circuit on a stale "already installed" marker.
  rm -rf "${HOME}/.claude/plugins/cache/optra-prism" 2>/dev/null || true
  rm -rf "${HOME}/.claude/plugins/data/prism-optra-prism" 2>/dev/null || true
  INSTALLED_JSON="${HOME}/.claude/plugins/installed_plugins.json"
  if [ -f "$INSTALLED_JSON" ] && command -v node &>/dev/null; then
    node - "$INSTALLED_JSON" <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, 'utf8'));
if (data && data.plugins && data.plugins['prism@optra-prism']) {
  delete data.plugins['prism@optra-prism'];
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  console.log('[prism] cleared stale installed_plugins.json entry');
}
NODE
  fi

  if claude plugin marketplace add "$MARKETPLACE_REPO" 2>/dev/null; then
    info "Marketplace registered: ${MARKETPLACE_REPO}"
  else
    info "Marketplace registration returned non-zero — may already be added."
  fi

  # Force install now (don't wait for next session) so the cache gets
  # overwritten with fresh source instead of being lazily reused.
  if claude plugin install "prism@optra-prism" 2>/dev/null; then
    info "Plugin installed (cache overwritten with fresh source)."
  else
    info "Plugin install deferred — will install on next Claude Code session."
  fi
else
  # Fallback: clone and register manually
  info "Claude Code CLI not found — installing manually..."
  mkdir -p "$INSTALL_DIR"

  if command -v git &>/dev/null; then
    info "Cloning plugin from ${MARKETPLACE_REPO}..."
    TMP_DIR=$(mktemp -d)
    git clone --depth 1 "https://github.com/${MARKETPLACE_REPO}.git" "$TMP_DIR" 2>/dev/null
    rm -rf "$INSTALL_DIR"
    mv "$TMP_DIR" "$INSTALL_DIR"
  elif command -v curl &>/dev/null; then
    info "Downloading plugin archive..."
    TMP_FILE=$(mktemp)
    curl -sL "https://github.com/${MARKETPLACE_REPO}/archive/refs/heads/main.tar.gz" -o "$TMP_FILE"
    tar -xzf "$TMP_FILE" --strip-components=1 -C "$INSTALL_DIR"
    rm -f "$TMP_FILE"
  else
    error "git or curl is required to download the plugin."
  fi

  info "Plugin installed to ${INSTALL_DIR}"
  echo ""
  echo "  Register manually when Claude Code is available:"
  echo "  claude config add plugins ${INSTALL_DIR}"
fi

# ─── Configure Prism if a key was provided ───

if [ -n "$API_KEY" ]; then
  PLUGIN_ROOT="${INSTALL_DIR}"
  # Marketplace installs live in the Claude Code plugin cache.
  if [ ! -f "$PLUGIN_ROOT/lib/setup.js" ]; then
    for p in "${HOME}/.claude/plugins/cache/optra-prism/prism"/*/; do
      if [ -f "$p/lib/setup.js" ]; then PLUGIN_ROOT="${p%/}"; break; fi
    done
  fi

  if [ -f "$PLUGIN_ROOT/lib/setup.js" ] && node "$PLUGIN_ROOT/lib/setup.js" apply "$API_KEY"; then
    info "Prism configured"
  else
    info "Configuration deferred. Run /prism:setup YOUR_KEY inside Claude Code."
  fi
else
  echo ""
  echo "No API key provided."
  echo ""
  echo "  Configure it inside Claude Code:"
  echo "  /prism:setup YOUR_KEY"
fi
echo ""
