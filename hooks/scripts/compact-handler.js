#!/usr/bin/env node
/** PostCompact advances the correlation barrier and context generation only. */

const { readStdin } = require('../../lib/stdin');
const { advanceCompactBarrier } = require('../../lib/session');

readStdin().then((data) => {
  if (data && data.session_id) advanceCompactBarrier(data.session_id);
}).catch(() => {});
