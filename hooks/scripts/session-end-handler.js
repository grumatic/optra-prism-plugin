#!/usr/bin/env node
/**
 * SessionEnd is the third and last host-observation read point (design
 * §5.3): one best-effort transcript read past the session's last active
 * record boundary, plus a session_end occurrence. Fixed order: (1) the
 * transcript read, (2) enqueue every observation found to the durable
 * outbox, (3) only then attempt one bounded delivery pass restricted to
 * exactly those freshly-enqueued entries, deadlined against the handler's
 * own remaining budget. An entry that fails, times out, or is never reached
 * simply stays in the outbox for the next session's SessionStart drain —
 * this handler never throws to the host and never blocks session teardown.
 */

const { readStdin } = require('../../lib/stdin');

// Well under the host's SessionEnd budget: reading stdin should be
// near-instant (Claude Code writes the whole hook input before invoking the
// command), so this only guards against a hung pipe.
const STDIN_BUDGET_MS = 1200;
// Overall wall-clock guards, measured from the start of main(). If stdin
// alone (or anything before the transcript read) has already used more than
// TRANSCRIPT_READ_BUDGET_MS, the transcript read is skipped (a gap is
// recorded instead of a silent drop) rather than risking the bulk of the
// remaining budget on a read that may not finish. If TOTAL_BUDGET_MS has
// elapsed by the time the read (or its skip) is decided, no further work is
// attempted at all, not even the network-free session_end enqueue.
const TRANSCRIPT_READ_BUDGET_MS = 1000;
const TOTAL_BUDGET_MS = 1400;

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function withBudget(promise, budgetMs) {
  // A late rejection from the raced-out promise must not surface as an
  // unhandled rejection once this function has already resolved.
  promise.catch(() => {});
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), budgetMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

async function main() {
  const startedAt = Date.now();
  const data = await withBudget(readStdin(), STDIN_BUDGET_MS);
  if (!data || !validSessionId(data.session_id)) return;
  if (Date.now() - startedAt > TOTAL_BUDGET_MS) return;

  try {
    const { readTurn } = require('../../lib/session');
    const { readPluginVersion } = require('../../lib/plugin-version');
    const { API_KEY, INGEST_URL } = require('../../lib/env');
    const {
      collectAndEnqueueHostObservations,
      enqueueSessionEnd,
      recordHostObservationGap,
    } = require('../../lib/host-observation-collection');

    const turn = readTurn(data.session_id);
    const active = turn && turn.active;
    const collectorVersion = readPluginVersion();
    const observedAt = new Date().toISOString();
    let hostVersion = null;
    const enqueuedIds = [];

    // Step 1: the transcript read (entry guard unchanged).
    if (active && active.submitPromptId) {
      if (Date.now() - startedAt > TRANSCRIPT_READ_BUDGET_MS) {
        recordHostObservationGap(data.session_id, active.submitPromptId, 'session_end_budget_exceeded');
      } else {
        const collected = collectAndEnqueueHostObservations({
          sessionId: data.session_id,
          transcriptPath: data.transcript_path,
          byteOffset: active.transcriptBoundary && active.transcriptBoundary.byteOffset,
          hostPromptId: active.submitPromptId,
          clientEventId: active.clientEventId,
          promptOutboxId: `prompt-${active.clientEventId}`,
          collectorVersion,
          observedAt,
        });
        if (collected.ok) {
          hostVersion = collected.hostVersion;
          enqueuedIds.push(...collected.enqueuedIds);
        }
      }
    }

    if (Date.now() - startedAt > TOTAL_BUDGET_MS) return;

    // Step 2: enqueue every observation found — durable on disk — before any
    // attempt to send anything (zero loss: a crash or a killed process after
    // this point still leaves everything for the next SessionStart drain).
    const sessionEndId = enqueueSessionEnd({
      sessionId: data.session_id,
      data,
      lastActiveHostPromptId: active && active.submitPromptId ? active.submitPromptId : null,
      collectorVersion,
      hostVersion,
      observedAt,
    });
    if (sessionEndId) enqueuedIds.push(sessionEndId);

    // Step 3: only now, a bounded delivery pass that sends the entries just
    // enqueued via prioritizeIds, deadlined against the handler's own
    // remaining budget. Missing API_KEY/INGEST_URL keeps this an
    // enqueue-only run — ingest.js's post() would no-op on every one of
    // these anyway, but skipping the attempt outright avoids spending any
    // budget on it. The limit floor mirrors the Stop handler's own
    // post-collection drain: drain() always attempts any other pending
    // response/prompt ahead of evidence-tier entries regardless of
    // prioritizeIds, so a limit equal to just our own count could starve
    // them behind a single stray one; the absolute deadline (not the limit)
    // is what bounds real elapsed time, so raising it costs nothing here.
    const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (enqueuedIds.length > 0 && API_KEY && INGEST_URL && remainingMs > 0) {
      const { deliverOutboxEntry } = require('../../lib/outbox-delivery');
      const { drain } = require('../../lib/response-outbox');
      await drain(deliverOutboxEntry, {
        limit: Math.max(enqueuedIds.length, 8),
        maxElapsedMs: remainingMs,
        prioritizeIds: enqueuedIds,
      });
    }
  } catch {
    // SessionEnd must never throw to the host.
  }
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = { main };
