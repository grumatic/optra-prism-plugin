#!/bin/bash
# ─── Session Start Hook ───
# Reads API key from userConfig (CLAUDE_PLUGIN_OPTION_*) or ~/.prism/config.json.
# Shows error on every session until a valid gck_* key is configured.
#
# OTEL env vars are NOT set here — they must exist before Claude Code starts.
# They live in ~/.claude/settings.json "env" section, written by install.sh
# or /prism:setup. This hook checks they're correct and fixes them for the
# next session if they've drifted.

set -euo pipefail

CONFIG_FILE="${HOME}/.prism/config.json"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-}"

# ─── Read API key (userConfig → legacy config) ───

API_KEY="${CLAUDE_PLUGIN_OPTION_apiKey:-}"

if [ -z "$API_KEY" ] && [ -f "$CONFIG_FILE" ]; then
  API_KEY=$(CONFIG_PATH="$CONFIG_FILE" node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH, 'utf8'));
      process.stdout.write(c.apiKey || '');
    } catch {}
  " 2>/dev/null || true)
fi

if [ -z "$API_KEY" ]; then
  echo "" >&2
  echo "[Prism] No API key configured." >&2
  echo "        Run /prism:setup to enter your gck_* key." >&2
  echo "" >&2
  exit 0
fi

# ─── Read other config (userConfig → legacy config → defaults) ───

PRISM_THRESHOLD="${CLAUDE_PLUGIN_OPTION_prismThreshold:-}"
ENABLE_GATEWAY="${CLAUDE_PLUGIN_OPTION_enableGateway:-}"

if [ -f "$CONFIG_FILE" ]; then
  if [ -z "$PRISM_THRESHOLD" ]; then
    PRISM_THRESHOLD=$(CONFIG_PATH="$CONFIG_FILE" node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH, 'utf8'));
        process.stdout.write(String(c.prismThreshold || ''));
      } catch {}
    " 2>/dev/null || true)
  fi
  if [ -z "$ENABLE_GATEWAY" ]; then
    ENABLE_GATEWAY=$(CONFIG_PATH="$CONFIG_FILE" node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH, 'utf8'));
        process.stdout.write(String(c.enableGateway || ''));
      } catch {}
    " 2>/dev/null || true)
  fi
fi

PRISM_THRESHOLD="${PRISM_THRESHOLD:-4}"
ENABLE_GATEWAY="${ENABLE_GATEWAY:-false}"

# Read env (userConfig → env var → legacy config)
if [ -z "${PRISM_ENV:-}" ]; then
  PRISM_ENV="${CLAUDE_PLUGIN_OPTION_environment:-}"
  if [ -z "$PRISM_ENV" ] && [ -f "$CONFIG_FILE" ]; then
    PRISM_ENV=$(CONFIG_PATH="$CONFIG_FILE" node -e "
      try {
        const c = JSON.parse(require('fs').readFileSync(process.env.CONFIG_PATH, 'utf8'));
        process.stdout.write(c.env || '');
      } catch {}
    " 2>/dev/null || true)
  fi
  PRISM_ENV="${PRISM_ENV:-production}"
fi

# ─── Validate key ───

case "$API_KEY" in
  gck_*) ;;
  *)
    echo "" >&2
    echo "[Prism] Invalid API key format: '${API_KEY:0:8}...'" >&2
    echo "        Expected key starting with gck_*" >&2
    echo "        Run /prism:setup to fix." >&2
    echo "" >&2
    exit 0
    ;;
esac

# ─── Environment → URLs ───

case "${PRISM_ENV}" in
  local)
    GATEWAY_URL="http://localhost:3003"
    PRISM_CODER_URL="http://localhost:9001"
    INGEST_URL="http://localhost:9005"
    ;;
  development|dev)
    GATEWAY_URL="https://gateway.dev.optra-ai.com/v1"
    PRISM_CODER_URL="https://dashboard.prism.dev.optra-ai.com"
    INGEST_URL="https://ingest.dev.optra-ai.com"
    ;;
  staging)
    GATEWAY_URL="https://gateway.staging.optra-ai.com/v1"
    PRISM_CODER_URL="https://dashboard.prism.staging.optra-ai.com"
    INGEST_URL="https://ingest.staging.optra-ai.com"
    ;;
  *)
    GATEWAY_URL="https://gateway.optra-ai.com/v1"
    PRISM_CODER_URL="https://dashboard.prism.optra-ai.com"
    INGEST_URL="https://ingest.optra-ai.com"
    ;;
esac

# ─── Check & sync OTEL settings in ~/.claude/settings.json ───

OTEL_STATUS=$(node "${PLUGIN_ROOT}/lib/settings.js" check 2>/dev/null) || true

if [ "$OTEL_STATUS" != "ok" ]; then
  if node "${PLUGIN_ROOT}/lib/settings.js" sync 2>/dev/null; then
    echo "[Prism] OTEL settings updated in ~/.claude/settings.json — restart Claude Code to apply." >&2
  else
    echo "[Prism] WARNING: Could not write OTEL settings to ~/.claude/settings.json" >&2
  fi
fi

# ─── Write env vars ───

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # Gateway routing — only when opted in
  if [ "$ENABLE_GATEWAY" = "true" ]; then
    cat >> "$CLAUDE_ENV_FILE" <<EOF
export ANTHROPIC_BASE_URL=${GATEWAY_URL}
export ANTHROPIC_CUSTOM_HEADERS="X-Gateway-Api-Key: ${API_KEY}
x-prism-source: claude-code"
EOF
  fi

  # Always set these (telemetry + scoring work without gateway)
  cat >> "$CLAUDE_ENV_FILE" <<EOF
export PRISM_THRESHOLD=${PRISM_THRESHOLD}
export PRISM_GCK_KEY=${API_KEY}
export PRISM_CODER_URL=${PRISM_CODER_URL}
export PRISM_INGEST_URL=${INGEST_URL}
export PRISM_DEBUG=${PRISM_DEBUG:-0}
EOF
fi

# ─── Version update notification ───

if [ -n "$DATA_DIR" ]; then
  PLUGIN_VERSION=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('${PLUGIN_ROOT}/.claude-plugin/plugin.json','utf8')).version)" 2>/dev/null || true)
  LAST_VERSION_FILE="${DATA_DIR}/last-version.txt"
  LAST_VERSION=""
  if [ -f "$LAST_VERSION_FILE" ]; then
    LAST_VERSION=$(cat "$LAST_VERSION_FILE" 2>/dev/null || true)
  fi
  if [ -n "$PLUGIN_VERSION" ]; then
    if [ -n "$LAST_VERSION" ] && [ "$LAST_VERSION" != "$PLUGIN_VERSION" ]; then
      echo "[Prism] Updated to v${PLUGIN_VERSION} (was v${LAST_VERSION})" >&2
    fi
    echo -n "$PLUGIN_VERSION" > "$LAST_VERSION_FILE"
  fi
fi

# ─── Confirmation ───

GATEWAY_STATUS="disabled"
if [ "$ENABLE_GATEWAY" = "true" ]; then
  GATEWAY_STATUS="enabled"
fi

echo "[Prism] Session started — env=${PRISM_ENV} gateway=${GATEWAY_STATUS} key=${API_KEY:0:12}... ingest=${INGEST_URL}" >&2

exit 0
