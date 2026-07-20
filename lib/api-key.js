function hasApiKey(value) {
  return typeof value === 'string' && value.length > 0;
}

module.exports = { hasApiKey };
