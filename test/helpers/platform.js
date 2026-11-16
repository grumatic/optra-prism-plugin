'use strict';

const IS_WINDOWS = process.platform === 'win32';

// Test options for a case whose mechanism exists only on POSIX; `reason`
// names that mechanism.
function posixOnly(reason) {
  return { skip: IS_WINDOWS ? `Windows: ${reason}` : false };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { IS_WINDOWS, posixOnly, escapeRegExp };
