#!/usr/bin/env node
/**
 * ─── UserPromptSubmit Hook ───
 *
 * 1. Scores the prompt locally for PQ (Prompt Quality).
 * 2. If PQ < threshold (default 4.0): blocks with coaching tips.
 * 3. If PQ >= threshold: captures to ingest and allows through.
 *
 * Input (stdin JSON from Claude Code):
 *   { session_id, prompt, cwd, hook_event_name, transcript_path, permission_mode }
 *
 * Output:
 *   exit 0 — allow prompt through
 *   exit 2 + stderr — block prompt, show coaching to user
 */

const { GCK_KEY, INGEST_URL, PRISM_THRESHOLD } = require('../../lib/env');
const { createDebug } = require('../../lib/debug');
const { readStdin } = require('../../lib/stdin');
const { sendPrompt } = require('../../lib/ingest');
const { scorePrompt } = require('../../lib/pq-scorer');

const debug = createDebug('submit-handler');

// Short prompts that are navigational / meta — skip scoring
const SKIP_PATTERNS = [
  /^\//, // slash commands
  /^(y|n|yes|no|ok|done|thanks|exit|quit|help|continue|go ahead|looks good|lgtm|approve)$/i,
  /^\!/, // shell passthrough
];

readStdin().then(async (data) => {
  const prompt = (data.prompt || '').trim();

  debug(`HOOK FIRED session_id=${data.session_id || '(none)'} prompt_length=${prompt.length} gck=${GCK_KEY ? 'set' : 'missing'}`);

  // Let /prism: commands through so user can configure the key
  if (prompt.startsWith('/prism:')) {
    debug('allowing /prism: command through');
    process.exit(0);
  }

  // If no key, block prompt with visible error
  if (!GCK_KEY || !INGEST_URL) {
    debug('BLOCKED: no API key or ingest URL');
    process.stderr.write('[Prism] API key not configured. Run /prism:setup to enter your gck_* key.\n');
    process.exit(2);
  }

  // Skip scoring for short navigational prompts
  const shouldSkip = prompt.length < 10 || SKIP_PATTERNS.some((p) => p.test(prompt));
  if (shouldSkip) {
    debug(`SKIP scoring: prompt too short or navigational`);
    captureAndAllow(data, prompt);
    return;
  }

  // ─── Score the prompt ───
  const { pq, specificity, decomposition, tips } = scorePrompt(prompt);
  debug(`PQ=${pq} specificity=${specificity} decomposition=${decomposition} threshold=${PRISM_THRESHOLD}`);

  if (pq < PRISM_THRESHOLD) {
    // Block with coaching
    const lines = [
      '',
      `[Prism] Prompt quality too low (PQ: ${pq.toFixed(1)}/10, threshold: ${PRISM_THRESHOLD.toFixed(1)})`,
      '',
    ];
    if (tips.length > 0) {
      lines.push('  Tips to improve:');
      for (const tip of tips) {
        lines.push(`    \u2022 ${tip}`);
      }
      lines.push('');
    }
    lines.push('  Rewrite your prompt and try again.');
    lines.push(`  (Change threshold: PRISM_THRESHOLD env var or prismThreshold in ~/.prism/config.json)`);
    lines.push('');

    const msg = lines.join('\n');
    debug(`BLOCKED: PQ=${pq} < ${PRISM_THRESHOLD}`);
    process.stderr.write(msg);
    process.exit(2);
    return;
  }

  // Allow through + capture
  captureAndAllow(data, prompt);

}).catch((err) => {
  debug(`FATAL: ${err.message || err}\n${err.stack || ''}`);
  process.exit(0); // fail open
});

async function captureAndAllow(data, prompt) {
  try {
    const result = await sendPrompt({
      prompt_text: prompt.slice(0, 2000),
      source: 'claude-code',
      tool_session_id: data.session_id,
      cwd: data.cwd,
    });
    debug(`INGEST OK: status=${result.status}`);
  } catch (err) {
    debug(`INGEST FAILED: ${err.message || err}`);
  }
  process.exit(0);
}
