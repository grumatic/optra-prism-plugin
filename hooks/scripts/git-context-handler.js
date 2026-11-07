#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  collectGitContext, resolveWorktreeRoot, resolveHeadAt, ROOT_BASELINE_DEADLINE_MS,
} = require('../../lib/git');
const {
  writeGit,
  readTurn,
  readTurnBaselines,
  turnBaselinesMatch,
  enterTurnRoot,
} = require('../../lib/session');
const { validHostPromptId } = require('../../lib/host-prompt-id');

function readHookStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(input)); } catch { resolve({}); }
    });
  });
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

function absolutePath(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

// The directory the turn has just moved into, for the two moves the host
// reports: a Bash `cd` (CwdChanged) and EnterWorktree, which changes the
// session's directory without a CwdChanged.
function enteredDirectory(data) {
  if (data.hook_event_name === 'CwdChanged') return absolutePath(data.new_cwd) ? data.new_cwd : null;
  if (data.hook_event_name === 'PostToolUse' && data.tool_name === 'EnterWorktree') {
    // The tool's own answer names the worktree it entered; the generic cwd
    // only follows it as long as the host reports the post-tool directory.
    const response = data.tool_response;
    if (response && absolutePath(response.worktreePath)) return response.worktreePath;
    return absolutePath(data.cwd) ? data.cwd : null;
  }
  return null;
}

function baselineSource(data) {
  return data.hook_event_name === 'CwdChanged' ? 'cwd_changed' : 'enter_worktree';
}

// A subagent's move changes its own directory, not the session's.
function fromSubagent(data) {
  return typeof data.agent_id === 'string' && data.agent_id.length > 0;
}

// Only the main conversation's own, still-open turn records a baseline: the
// prompt_id must name the active turn, and a subagent's move is not the
// session's.
function activeTurnFor(data) {
  if (fromSubagent(data)) return null;
  if (!validHostPromptId(data.prompt_id)) return null;
  const turn = readTurn(data.session_id);
  const active = turn && turn.active;
  if (
    !active
    || turn.kind !== 'normal-pending'
    || !['submitting', 'captured'].includes(active.status)
    || active.submitPromptId !== data.prompt_id
  ) return null;
  return { epoch: turn.epoch, clientEventId: active.clientEventId };
}

/**
 * Records the baseline of the worktree root the turn just entered. It is
 * the head that root had at the turn's submit (or, once that root's leave
 * evidence was emitted, at that moment), read from the root's reflog:
 * CwdChanged runs only after the whole Bash command, so the current head
 * would already include a commit made by `cd <worktree> && git commit`.
 * Without a usable reflog the current head is the remaining baseline, but
 * only when it was committed before the turn began; a later one may be such
 * a same-command commit, so the root then gets none. Stop reads the reflog again
 * first and uses this stored head only when that still fails.
 */
async function recordEnteredRoot(data, directory) {
  const expected = activeTurnFor(data);
  if (!expected) return;
  const record = readTurnBaselines(data.session_id);
  if (!turnBaselinesMatch(record, expected)) return;
  // No Git for a baseline a service that takes no commit evidence never uses.
  const { readCapabilityCache, capabilityAllowsEvidence } = require('../../lib/git-evidence-capability');
  if (!capabilityAllowsEvidence(readCapabilityCache())) return;

  // One budget for the root and the reflog lookups together.
  const deadlineAt = Date.now() + ROOT_BASELINE_DEADLINE_MS;
  const root = await resolveWorktreeRoot(directory, ROOT_BASELINE_DEADLINE_MS, { deadlineAt });
  if (root === record.currentRoot) return;
  if (!root) {
    // Outside any worktree: the turn has left the current root.
    enterTurnRoot(data.session_id, expected, { root: null });
    return;
  }

  const existing = record.roots.find((entry) => entry.root === root);
  let baseline = null;
  if (!existing || existing.emittedAt !== undefined) {
    const at = existing ? existing.emittedAt : record.submittedAt;
    // The prompt root was this turn's directory from the start, so its
    // current head may already include the turn's commits: it gets a
    // baseline only from the reflog, never the current-head fallback. When
    // the prompt root is unknown (the submit-time lookup failed), any root
    // may be it, so none gets the fallback.
    const fallbackToCurrent = record.promptRoot !== null && root !== record.promptRoot;
    baseline = await resolveHeadAt(root, at, { fallbackToCurrent, deadlineAt });
  }
  enterTurnRoot(data.session_id, expected, {
    root,
    head: baseline ? baseline.head : null,
    observedAt: baseline ? baseline.observedAt : new Date().toISOString(),
    source: baselineSource(data),
  });
}

async function main() {
  const data = await readHookStdin();
  if (!validSessionId(data.session_id)) return;
  const directory = enteredDirectory(data);
  if (!directory) return;

  // EnterWorktree moves the session without a CwdChanged, so the session Git
  // record (the repository identity Stop falls back to) follows it here too.
  if (data.hook_event_name === 'CwdChanged' || !fromSubagent(data)) {
    writeGit(data.session_id, await collectGitContext(directory));
  }
  try { await recordEnteredRoot(data, directory); } catch {}
}

main().catch(() => {});
