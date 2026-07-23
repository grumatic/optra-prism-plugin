/**
 * Public Prism runtime configuration fields.
 *
 * This registry is the single source of truth for user-editable field names,
 * defaults, validation hints, help text, and legacy storage aliases.
 */

const CONFIG_FIELDS = Object.freeze([
  Object.freeze({
    name: 'show_realtime_summary',
    legacyNames: Object.freeze(['showRealtimeSummary']),
    type: 'boolean',
    defaultValue: false,
    allowedValues: 'true | false',
    applies: 'Next hook invocation',
    description: 'Show the server-side realtime summary after completed turns.',
  }),
  Object.freeze({
    name: 'ingest_url',
    legacyNames: Object.freeze([]),
    type: 'URL',
    defaultValue: null,
    allowedValues: 'HTTPS URL or loopback HTTP URL',
    applies: 'Restart Claude Code',
    description: 'Route Prism ingest, realtime, report, config, and OTEL traffic.',
  }),
]);

const CONFIG_FIELDS_BY_NAME = new Map(CONFIG_FIELDS.map((field) => [field.name, field]));

function getConfigField(name) {
  return CONFIG_FIELDS_BY_NAME.get(name) || null;
}

function getConfigDefaults() {
  return Object.fromEntries(CONFIG_FIELDS.map((field) => [field.name, field.defaultValue]));
}

function normalizeConfigFields(value) {
  const normalized = { ...value };

  for (const field of CONFIG_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(normalized, field.name)) {
      const legacyName = field.legacyNames.find((name) =>
        Object.prototype.hasOwnProperty.call(normalized, name));
      if (legacyName) normalized[field.name] = normalized[legacyName];
    }
    for (const legacyName of field.legacyNames) delete normalized[legacyName];
  }

  return normalized;
}

module.exports = {
  CONFIG_FIELDS,
  getConfigDefaults,
  getConfigField,
  normalizeConfigFields,
};
