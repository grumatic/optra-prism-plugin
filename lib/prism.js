/**
 * PRISM score client.
 * Calls the Prism server for prompt scoring.
 *
 * Used by: hooks (submit-handler) and commands (prism, status).
 */

const { GCK_KEY, CODER_URL } = require('./env');
const { createDebug } = require('./debug');

const debug = createDebug('prism');

/**
 * Score a prompt via the Coder server.
 * @param {string} promptText
 * @returns {Promise<{ overall: number, label: string, coachingNotes: string[] } | null>}
 */
async function scorePrism(promptText) {
  if (!GCK_KEY || !CODER_URL) {
    debug('SKIP: no GCK_KEY or CODER_URL');
    return null;
  }

  const scoreUrl = `${CODER_URL}/api/prism/score`;
  debug(`POST ${scoreUrl}`);

  try {
    const response = await fetch(scoreUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': GCK_KEY,
      },
      body: JSON.stringify({ prompt: promptText.slice(0, 2000) }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      debug(`ERROR: status=${response.status} body=${errBody.slice(0, 300)}`);
      return null;
    }

    const data = await response.json();
    debug(`RESULT: overall=${data.overall} label=${data.label}`);
    return {
      overall: clamp(data.overall ?? 5.0, 0, 10),
      label: data.label || getLabel(data.overall ?? 5.0),
      pq: data.pq || null,
      coachingNotes: Array.isArray(data.coachingNotes) ? data.coachingNotes.slice(0, 3) : [],
    };
  } catch (err) {
    debug(`FETCH ERROR: ${err.message || err}`);
    return null;
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getLabel(score) {
  if (score >= 9.0) return 'elite';
  if (score >= 7.0) return 'expert';
  if (score >= 5.0) return 'proficient';
  if (score >= 3.0) return 'practitioner';
  return 'novice';
}

module.exports = { scorePrism, getLabel };
