/**
 * ─── Local PQ (Prompt Quality) Scorer ───
 *
 * Port of the heuristic PQ scoring from prism-engine (prism.rs:113-172).
 * Runs locally in the plugin hook — no network calls needed.
 *
 * Scoring:
 *   Specificity: 6 regex signals, max 10.0
 *   Decomposition: verb/bundling analysis, max 10.0
 *   PQ = (specificity + decomposition) / 2
 *
 * Returns { pq, specificity, decomposition, tips }
 */

// ─── Specificity signals (prism.rs:113-136) ───

const SPECIFICITY_SIGNALS = [
  { pattern: /[\w\-/]+\.\w{1,6}/,                      points: 2.5, tip: 'Reference specific files (e.g., src/auth.ts)' },
  { pattern: /(?:function|method|class|def|fn)\s+\w+/i, points: 2.0, tip: 'Name the function or class to modify' },
  { pattern: /(?:line\s+\d+|L\d+|:\d+)/,                points: 1.5, tip: 'Include line numbers (e.g., auth.ts:47)' },
  { pattern: /(?:error|exception|failed|TypeError|ReferenceError|panic|ENOENT)/i, points: 1.5, tip: null },
  { pattern: /\b(?:should|must|returns?|throws?|expects?|produces?)\b/i,          points: 1.5, tip: 'Describe expected behavior (e.g., "should return 403")' },
  { pattern: /`[^`]+`|```/,                              points: 1.0, tip: null },
];

// ─── Decomposition signals (prism.rs:140-172) ───

const ACTION_VERBS = /\b(?:add|create|fix|update|remove|delete|refactor|implement|change|move|rename|replace|extract|write|build|migrate|convert|split|merge)\b/gi;
const BUNDLING_PHRASES = /\b(?:and also|while you'?re at it|and then|plus also|also add|also update|also fix|as well as)\b/gi;
const LIST_PATTERN = /(?:^|\n)\s*[-*\d+.]\s+/g;
const SCOPE_WORDS = /\b(?:only|just|specifically|exclusively|solely|nothing else)\b/i;

/**
 * Score a prompt's quality.
 * @param {string} prompt - Raw user prompt text
 * @returns {{ pq: number, specificity: number, decomposition: number, tips: string[] }}
 */
function scorePrompt(prompt) {
  if (!prompt || prompt.length < 3) {
    return { pq: 0, specificity: 0, decomposition: 0, tips: ['Write a more detailed prompt.'] };
  }

  // ─── Specificity ───
  let specificity = 0;
  const tips = [];

  for (const signal of SPECIFICITY_SIGNALS) {
    if (signal.pattern.test(prompt)) {
      specificity += signal.points;
    } else if (signal.tip) {
      tips.push(signal.tip);
    }
  }
  specificity = Math.min(specificity, 10);

  // ─── Decomposition ───
  const verbs = (prompt.match(ACTION_VERBS) || []).length;
  const bundling = (prompt.match(BUNDLING_PHRASES) || []).length;
  const listItems = (prompt.match(LIST_PATTERN) || []).length;
  const hasScope = SCOPE_WORDS.test(prompt);

  let decomposition = verbs > 0 ? 4.0 : 2.0;
  // Penalty for multiple action verbs (multi-task prompt)
  if (verbs > 1) decomposition -= (verbs - 1) * 1.5;
  // Penalty for bundling phrases
  decomposition -= bundling * 2.0;
  // Penalty for long lists (3+ items)
  if (listItems >= 3) decomposition -= 2.5;
  // Bonus for scoping language
  if (hasScope) decomposition += 2.0;

  decomposition = Math.max(0, Math.min(decomposition, 10));

  if (verbs > 2) {
    tips.push('Break into smaller prompts \u2014 one task per prompt');
  }
  if (bundling > 0) {
    tips.push('Avoid bundling tasks with "and also", "while you\'re at it"');
  }

  const pq = Math.round(((specificity + decomposition) / 2) * 10) / 10;

  return { pq, specificity, decomposition, tips: tips.slice(0, 3) };
}

module.exports = { scorePrompt };
