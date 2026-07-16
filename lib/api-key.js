const crypto = require('crypto');

const PRIMARY_PREFIX = 'prism_';
const LEGACY_PREFIX = 'gck_';

function isSupportedApiKey(value) {
  return typeof value === 'string'
    && (value.startsWith(PRIMARY_PREFIX) || value.startsWith(LEGACY_PREFIX));
}

function fingerprintApiKey(value) {
  if (typeof value !== 'string' || !value) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

module.exports = {
  PRIMARY_PREFIX,
  LEGACY_PREFIX,
  isSupportedApiKey,
  fingerprintApiKey,
};
