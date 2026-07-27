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
# This is the only consumer of hook stdin. It advances the lifecycle barrier
# before any version activation or update check, then emits at most one JSON
# system message.
PRISM_PLUGIN_ROOT="$PRISM_PLUGIN_ROOT" \
  node "$PRISM_PLUGIN_ROOT/hooks/scripts/session-start-handler.js" || true
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
    PRISM_PLUGIN_ROOT="$PLUGIN_ROOT" node -e '
      const fs = require("fs");
      const path = require("path");
      const { getConfig } = require(path.join(process.env.PRISM_PLUGIN_ROOT, "lib", "config"));
      const config = getConfig();
      // Config values are read from the authority file, never handed over as
      // environment variables. Only host-provided paths arrive through env.
      const dataDir = process.env.CLAUDE_PLUGIN_DATA;
      const report = (status) => {
        if (config.debug !== true) return;
        try {
          fs.appendFileSync(
            path.join(dataDir, "model-catalog-refresh.debug.log"),
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
        ingestUrl: config.ingest_url,
        apiKey: config.apiKey,
        dataDir,
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

echo "[Prism] Session started — Prism API key present" >&2
echo "[Prism] Endpoints:" >&2
echo "        Ingest:    ${INGEST_URL}" >&2

exit 0
