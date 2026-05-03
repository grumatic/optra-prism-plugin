#!/bin/bash
# ─── Session Start Hook ───
# Reads API key from userConfig (CLAUDE_PLUGIN_OPTION_*) or ~/.prism/config.json.
# Resolves service URLs from config endpoint cache (lib/config.js).
# Shows error on every session until a valid gck_* key is configured.
#
# OTEL env vars are NOT set here — they must exist before Claude Code starts.
# They live in one of:
#   ~/.claude/settings.json                         (user scope)
#   $CLAUDE_PROJECT_DIR/.claude/settings.local.json (project scope)
# written by install.sh or /prism:setup. This hook detects the active scope
# and verifies the vars are correct; if they've drifted it re-syncs them for
# the next session.

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
  echo "        Reinstall with: /plugin install prism  (you'll be prompted for your key)" >&2
  echo "        Or run: /prism:setup gck_YOUR_KEY" >&2
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
ENABLE_GATEWAY="${ENABLE_GATEWAY:-true}"

# ─── Validate key ───

case "$API_KEY" in
  gck_*) ;;
  *)
    echo "" >&2
    echo "[Prism] Invalid API key format: '${API_KEY:0:8}...'" >&2
    echo "        Expected key starting with gck_*" >&2
    echo "        Reinstall with: /plugin install prism  (you'll be prompted for your key)" >&2
    echo "" >&2
    exit 0
    ;;
esac

# ─── Resolve URLs from config endpoint (cache → fetch → production fallback) ───
#
# getConfig() reads cache + production fallbacks only (no env var overrides).
# This prevents a self-reinforcing loop where this hook writes PRISM_INGEST_URL
# to CLAUDE_ENV_FILE → next session getConfig() reads it → writes it again,
# permanently locking to localhost even after setup.

RESOLVED_URLS=$(node -e "
  const { getCachedConfig, getConfig, fetchConfig } = require('${PLUGIN_ROOT}/lib/config');
  const apiKey = '${API_KEY}';

  async function resolve() {
    // Use the cache only if it actually exists and is valid (getCachedConfig
    // returns null on miss/expiry/key change). getConfig() can't be used to
    // detect a miss because it falls back to production URLs unconditionally.
    const cached = getCachedConfig(apiKey);
    if (cached) return cached;
    // Cache miss — fetch from config endpoint, then fall back to prod URLs.
    const fetched = await fetchConfig(apiKey);
    return fetched || getConfig(apiKey);
  }

  resolve()
    .then(c => process.stdout.write(JSON.stringify(c)))
    .catch(() => process.stdout.write('{}'));
" 2>/dev/null || echo '{}')

INGEST_URL=$(echo "$RESOLVED_URLS" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(d.ingest_url || '');
" 2>/dev/null || true)

GATEWAY_URL=$(echo "$RESOLVED_URLS" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(d.gateway_url || '');
" 2>/dev/null || true)

ANTHROPIC_BASE_URL=$(echo "$RESOLVED_URLS" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(d.anthropic_base_url || d.gateway_url || '');
" 2>/dev/null || true)

# Only PRISM_INGEST_URL can be overridden (for local dev).
# Default to production if config endpoint and cache are both unavailable.
INGEST_URL="${PRISM_INGEST_URL:-${INGEST_URL:-https://ingest.prism.optra-ai.com}}"

# ─── Resolve OTEL scope and sync ───
#
# The plugin stores OTEL vars in exactly one scope (user or project-local).
# resolveOtelScope() determines the correct scope from install metadata and
# existing OTEL state. It never defaults to user scope on unknown — it refuses
# instead, and auto-repairs misplaced OTEL vars when the install scope is known.

PROJECT_DIR_ARG=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  PROJECT_DIR_ARG="--project-dir ${CLAUDE_PROJECT_DIR}"
fi

# resolve-scope output: action:targetScope:removeScopes (colon-delimited)
RESOLVE_RAW=$(node "${PLUGIN_ROOT}/lib/settings.js" resolve-scope ${PROJECT_DIR_ARG} 2>/dev/null) || true

if [ -z "$RESOLVE_RAW" ]; then
  echo "[Prism] WARNING: scope detection failed — OTEL not configured. Restart session." >&2
else
  RESOLVE_ACTION="${RESOLVE_RAW%%:*}"
  RESOLVE_REST="${RESOLVE_RAW#*:}"
  TARGET_SCOPE="${RESOLVE_REST%%:*}"
  REMOVE_SCOPES_CSV="${RESOLVE_REST#*:}"

  case "$RESOLVE_ACTION" in
    repair)
      IFS=',' read -ra RSCOPES <<< "$REMOVE_SCOPES_CSV"
      for RSCOPE in "${RSCOPES[@]}"; do
        [ -n "$RSCOPE" ] && node "${PLUGIN_ROOT}/lib/settings.js" remove --scope "$RSCOPE" ${PROJECT_DIR_ARG} 2>/dev/null || true
      done
      if node "${PLUGIN_ROOT}/lib/settings.js" sync --scope "$TARGET_SCOPE" ${PROJECT_DIR_ARG} 2>/dev/null; then
        echo "[Prism] OTEL settings repaired (moved to scope=${TARGET_SCOPE}) — restart Claude Code to apply." >&2
      fi
      ;;
    sync)
      OTEL_STATUS=$(node "${PLUGIN_ROOT}/lib/settings.js" check --scope "$TARGET_SCOPE" ${PROJECT_DIR_ARG} 2>/dev/null) || true
      if [ "$OTEL_STATUS" != "ok" ]; then
        if node "${PLUGIN_ROOT}/lib/settings.js" sync --scope "$TARGET_SCOPE" ${PROJECT_DIR_ARG} 2>/dev/null; then
          echo "[Prism] OTEL settings updated (scope=${TARGET_SCOPE}) — restart Claude Code to apply." >&2
        else
          echo "[Prism] WARNING: Could not write OTEL settings (scope=${TARGET_SCOPE})" >&2
        fi
      fi
      ;;
    skip)
      echo "[Prism] WARNING: Could not determine OTEL scope — telemetry not configured. Restart session." >&2
      ;;
  esac
fi

# ─── Write env vars ───

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # Gateway routing — only when opted in
  if [ "$ENABLE_GATEWAY" = "true" ] && [ -n "$ANTHROPIC_BASE_URL" ]; then
    cat >> "$CLAUDE_ENV_FILE" <<EOF
export ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}
export ANTHROPIC_CUSTOM_HEADERS="X-Gateway-Api-Key: ${API_KEY}
x-prism-source: claude-code"
EOF
  fi

  # Always set these (telemetry + scoring work without gateway)
  # Note: PRISM_INGEST_URL is intentionally NOT exported here to avoid a
  # self-reinforcing loop where the hook-set value persists across sessions,
  # making it impossible to distinguish user overrides from hook defaults.
  # Skills and lib/env.js fall back to config cache → production URL when unset.
  cat >> "$CLAUDE_ENV_FILE" <<EOF
export PRISM_THRESHOLD=${PRISM_THRESHOLD}
export PRISM_GCK_KEY=${API_KEY}
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

# ─── Reset session state ───

if [ -n "$DATA_DIR" ]; then
  STATE_FILE="${DATA_DIR}/session-state.json"
  node -e "
    const fs = require('fs');
    fs.mkdirSync('${DATA_DIR}', { recursive: true });
    fs.writeFileSync('${STATE_FILE}', JSON.stringify({ turnCount: 0, sessionStart: Date.now(), sessionId: '' }));
  " 2>/dev/null || true
fi

# ─── Confirmation ───

GATEWAY_STATUS="disabled"
if [ "$ENABLE_GATEWAY" = "true" ]; then
  GATEWAY_STATUS="enabled"
fi

echo "[Prism] Session started — gateway=${GATEWAY_STATUS} key=${API_KEY:0:12}..." >&2
echo "[Prism] Endpoints:" >&2
echo "        Ingest:    ${INGEST_URL:-unknown}" >&2
echo "        Gateway:   ${GATEWAY_URL:-unknown}" >&2
echo "        Anthropic: ${ANTHROPIC_BASE_URL:-unknown}" >&2

exit 0
