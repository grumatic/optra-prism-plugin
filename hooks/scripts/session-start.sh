#!/bin/bash
# ─── Session Start Hook ───
# Reads Prism runtime configuration only from ~/.prism/config.json.
# Shows an error on every session until an API key is configured.

# ─── Isolated lifecycle barrier (must run before every early exit) ───
#
# Resolve only the helper's path without strict-mode expansions so a missing
# HOME or fallback-root calculation cannot bypass the lifecycle barrier.
PRISM_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PRISM_PLUGIN_ROOT" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)" || SCRIPT_DIR=""
  PRISM_PLUGIN_ROOT="${SCRIPT_DIR:+$(cd "$SCRIPT_DIR/../.." >/dev/null 2>&1 && pwd)}"
fi
#
# This is the only consumer of hook stdin. It validates session identity and
# source, then independently refreshes only sanitized Git context from cwd.
PRISM_PLUGIN_ROOT="$PRISM_PLUGIN_ROOT" node -e '
  const path = require("path");
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", async () => {
    let debug = false;
    try {
      const { getConfig } = require(path.join(process.env.PRISM_PLUGIN_ROOT, "lib", "config"));
      debug = getConfig().debug === true;
    } catch {}
    const report = (reason) => {
      if (debug) process.stderr.write(`[Prism debug] SessionStart barrier skipped: ${reason}\n`);
    };
    try {
      const session = require(path.join(process.env.PRISM_PLUGIN_ROOT, "lib", "session"));
      session.cleanupStaleSessions();
      const data = JSON.parse(input);
      const sessionId = data && data.session_id;
      const source = data && data.source;
      if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 1024) {
        report("invalid session identity");
        return;
      }
      if (typeof source !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(source)) {
        report("invalid source");
        return;
      }
      if (!session.advanceBarrier(sessionId, "lifecycle")) report("lock unavailable");
      const cwd = data && data.cwd;
      if (typeof cwd === "string" && cwd.length > 0) {
        try {
          const { collectGitContext } = require(path.join(process.env.PRISM_PLUGIN_ROOT, "lib", "git"));
          const context = await collectGitContext(cwd);
          session.writeGit(sessionId, context);
        } catch {
          report("git context refresh failed");
        }
      }
    } catch {
      report("helper failure");
    }
  });
' || true
set -euo pipefail

PLUGIN_ROOT="$PRISM_PLUGIN_ROOT"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-}"

# ─── Read runtime config ───

if ! INGEST_URL=$(PRISM_PLUGIN_ROOT="$PLUGIN_ROOT" node -e '
  const path = require("path");
  try {
    const { getConfig, isSupportedIngestUrl } = require(path.join(process.env.PRISM_PLUGIN_ROOT, "lib", "config"));
    const config = getConfig();
    if (typeof config.apiKey !== "string" || config.apiKey.length === 0) {
      process.stderr.write("\n[Prism] No API key configured.\n");
      process.stderr.write("        Run: /prism:setup YOUR_KEY\n\n");
      process.exit(1);
    }
    if (!isSupportedIngestUrl(config.ingest_url)) {
      process.stderr.write("[Prism] ingest_url in ~/.prism/config.json is missing or unsupported.\n");
      process.stderr.write("        Use HTTPS, or HTTP on loopback, without credentials, query, or fragment.\n");
      process.stderr.write("        Run /prism:setup YOUR_KEY, or set it with /prism:config, then retry.\n");
      process.exit(1);
    }
    process.stdout.write(config.ingest_url);
  } catch (error) {
    process.stderr.write(`[Prism] Unable to read ~/.prism/config.json: ${error.message}\n`);
    process.exit(1);
  }
'); then
  exit 0
fi

# ─── Refresh model catalog cache (detached, fail-open) ───
#
# The cache feeds *future* Stop hooks, so SessionStart never waits on it: the
# fetch runs as a detached background process with all stdio closed (an
# inherited pipe would keep the hook alive). Atomic temp-file + rename
# publication means a killed or failed refresh can never leave partial state;
# every failure keeps the existing last-known-good cache. The process
# self-limits with a hard guard above the request timeout. With config debug
# enabled, the outcome is appended to model-catalog-refresh.debug.log in DATA_DIR.
if [ -n "$INGEST_URL" ] && [ -n "$DATA_DIR" ]; then
  (
    PRISM_CATALOG_INGEST_URL="$INGEST_URL" PRISM_CATALOG_DATA_DIR="$DATA_DIR" PRISM_PLUGIN_ROOT="$PLUGIN_ROOT" node -e '
      const fs = require("fs");
      const path = require("path");
      const { getConfig } = require(path.join(process.env.PRISM_PLUGIN_ROOT, "lib", "config"));
      const config = getConfig();
      const report = (status) => {
        if (config.debug !== true) return;
        try {
          fs.appendFileSync(
            path.join(process.env.PRISM_CATALOG_DATA_DIR, "model-catalog-refresh.debug.log"),
            `${new Date().toISOString()} ${status}\n`,
          );
        } catch {}
      };
      const guard = setTimeout(() => {
        report("kept-cache hook-time-budget");
        process.exit(0);
      }, 1300);
      const { refreshCatalog } = require(path.join(process.env.PRISM_PLUGIN_ROOT, "lib", "model-catalog"));
      refreshCatalog({
        ingestUrl: process.env.PRISM_CATALOG_INGEST_URL,
        apiKey: config.apiKey,
        dataDir: process.env.PRISM_CATALOG_DATA_DIR,
        timeoutMs: 1000,
      }).then((status) => {
        clearTimeout(guard);
        report(status);
        process.exit(0);
      }).catch(() => {
        clearTimeout(guard);
        report("kept-cache request-failed");
        process.exit(0);
      });
    ' >/dev/null 2>&1 </dev/null &
  ) || true
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

echo "[Prism] Session started — Prism API key present" >&2
echo "[Prism] Endpoints:" >&2
echo "        Ingest:    ${INGEST_URL}" >&2

exit 0
