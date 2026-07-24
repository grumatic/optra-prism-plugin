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

# ─── Recover prior durable ingest intents ───
# Run only after key and URL resolution, with the same bounded hook budget used
# by submit/stop. Prompt entries are acknowledged only after session promotion.
PRISM_PLUGIN_ROOT="$PLUGIN_ROOT" node <<'NODE' || true
  const path = require("path");
  const root = process.env.PRISM_PLUGIN_ROOT;
  const { sendPrompt, sendResponse } = require(path.join(root, "lib", "ingest"));
  const { drain } = require(path.join(root, "lib", "response-outbox"));
  const { promoteActive, readTurn, validServerPromptId } = require(path.join(root, "lib", "session"));

  function serverPromptId(body) {
    try {
      const parsed = JSON.parse(body);
      return parsed && validServerPromptId(parsed.id) ? parsed.id : null;
    } catch {
      return null;
    }
  }
  function isTerminalDroppedPromptAck(body) {
    try {
      return JSON.parse(body).id === "00000000-0000-0000-0000-000000000000";
    } catch {
      return false;
    }
  }

  function promptIsPromoted(entry, promptId) {
    const promotion = entry.promotion;
    if (!promotion) return true;
    if (!promptId) return false;
    if (promoteActive(promotion.sessionId, promotion.clientEventId, promotion.hostPromptId, promptId)) return true;
    const turn = readTurn(promotion.sessionId);
    return Boolean(
      turn
      && turn.epoch === promotion.epoch
      && turn.active
      && turn.active.clientEventId === promotion.clientEventId
      && turn.active.submitPromptId === promotion.hostPromptId
      && turn.active.serverPromptId === promptId
      && ["captured", "consumed"].includes(turn.active.status)
    );
  }

  drain(async (entry, options) => {
    const result = await (entry.kind === "prompt" ? sendPrompt(entry.payload, options) : sendResponse(entry.payload, options));
    if (entry.kind !== "prompt" || !result || result.status < 200 || result.status >= 300) return result;
    // Ingest uses 200 plus the nil UUID for intentionally dropped internal
    // utility prompts. It is terminal, but must not promote a server prompt id.
    return {
      ...result,
      ack: isTerminalDroppedPromptAck(result.body) || promptIsPromoted(entry, serverPromptId(result.body)),
    };
  }, { limit: 32, maxElapsedMs: 2000 }).catch(() => {});
NODE
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
