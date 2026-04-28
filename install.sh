#!/bin/bash
# ─── Prism Plugin Installer ───
# Installs via Claude Code marketplace (preferred) or manual clone (fallback).
#
# Usage:
#   curl -sL https://optra-ai.com/install-plugin.sh | bash -s -- gck_YOUR_KEY
#   curl -sL https://optra-ai.com/install-plugin.sh | bash   # configure key later

set -euo pipefail

MARKETPLACE_REPO="grumatic/optra-prism-plugin"
INSTALL_DIR="${HOME}/.prism/claude-code-plugin"
CONFIG_DIR="${HOME}/.prism"
CONFIG_FILE="${CONFIG_DIR}/config.json"
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

# ─── Save API key if provided ───

if [ -n "$API_KEY" ]; then
  case "$API_KEY" in
    gck_*)
      mkdir -p "$CONFIG_DIR"
      chmod 700 "$CONFIG_DIR"
      # Wipe stale config cache so the new key fetches fresh URLs.
      rm -f "${CONFIG_DIR}/config-cache.json"
      cat > "$CONFIG_FILE" <<EOF
{
  "apiKey": "${API_KEY}",
  "prismThreshold": 4,
  "enableGateway": true
}
EOF
      chmod 600 "$CONFIG_FILE"
      info "API key saved: ${API_KEY:0:12}..."

      # Sync OTEL settings — respect the existing scope if Prism was already
      # set up via /prism:setup --project, so we don't duplicate vars.
      PLUGIN_ROOT="${INSTALL_DIR}"
      # Marketplace install lands in the cache, not INSTALL_DIR — fall back to it.
      if [ ! -f "$PLUGIN_ROOT/lib/settings.js" ]; then
        for p in "${HOME}/.claude/plugins/cache/optra-prism/prism"/*/; do
          if [ -f "$p/lib/settings.js" ]; then PLUGIN_ROOT="${p%/}"; break; fi
        done
      fi
      if [ -f "$PLUGIN_ROOT/lib/settings.js" ]; then
        CURRENT_SCOPE=$(node "$PLUGIN_ROOT/lib/settings.js" detect 2>/dev/null || echo "none")
        if [ "$CURRENT_SCOPE" = "none" ]; then
          INSTALL_SCOPE=$(node "$PLUGIN_ROOT/lib/settings.js" install-scope 2>/dev/null || echo "unknown")
          case "$INSTALL_SCOPE" in
            user)           TARGET_SCOPE="user" ;;
            project|local)  TARGET_SCOPE="project" ;;
            *)              TARGET_SCOPE="user" ;;
          esac
        else
          TARGET_SCOPE="$CURRENT_SCOPE"
          case "$CURRENT_SCOPE" in
            project|both)
              info "Existing project-scope setup detected — keeping it (run /prism:setup --user to switch)."
              TARGET_SCOPE="project"
              ;;
          esac
        fi
        node "$PLUGIN_ROOT/lib/settings.js" sync --scope "$TARGET_SCOPE" 2>/dev/null && \
          info "OTEL telemetry configured (scope=${TARGET_SCOPE})" || \
          info "WARNING: Could not write OTEL settings — restart Claude Code after starting"
      fi

      echo ""
      echo "Start Claude Code — the plugin activates automatically."
      echo "Gateway routing is enabled by default. Run /prism:status to toggle it."
      ;;
    *)
      echo ""
      echo "[prism] WARNING: Invalid key format — expected gck_*. Key not saved."
      echo "Run /prism:setup inside Claude Code to configure."
      ;;
  esac
else
  echo ""
  echo "No API key provided. You'll be prompted for it when installing the plugin."
  echo ""
  echo "  Or reinstall with your key:"
  echo "  curl -sL https://optra-ai.com/install-plugin.sh | bash -s -- gck_YOUR_KEY"
fi
echo ""
