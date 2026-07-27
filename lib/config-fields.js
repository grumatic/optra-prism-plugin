/**
 * Public Prism runtime configuration fields.
 *
 * This registry is the single source of truth for field names, defaults,
 * validation hints, help text, and legacy storage aliases.
 *
 * `editable` marks the fields `/prism:config` may show and change. Fields that
 * are owned by `/prism:setup` (`apiKey`) or derived from the server
 * (`dashboard_url`) are registered so they gain defaults and source
 * attribution, but stay out of the user-facing surface.
 *
 * `debug` is deliberately absent. It stays an unregistered read-only escape
 * hatch that only acts when explicitly stored as `true`; registering it would
 * advertise a debug mode in `/prism:config` and `/prism:help`.
 *
 * `~/.prism/config.json` is shared by every plugin version installed on the
 * machine, including versions pinned to a single project that will never be
 * updated. Only additive changes are safe: never rename or repurpose a stored
 * field name. A field may only be dropped once every version that still reads
 * it falls back to a default without it.
 */

const CONFIG_FIELDS = Object.freeze([
  Object.freeze({
    name: 'show_realtime_summary',
    legacyNames: Object.freeze(['showRealtimeSummary']),
    editable: true,
    type: 'boolean',
    defaultValue: false,
    allowedValues: 'true | false',
    applies: 'Next hook invocation',
    description: 'Show the server-side realtime summary after completed turns.',
  }),
  Object.freeze({
    name: 'ingest_url',
    legacyNames: Object.freeze([]),
    editable: true,
    type: 'URL',
    defaultValue: null,
    allowedValues: 'HTTPS URL or loopback HTTP URL',
    applies: 'Restart Claude Code',
    description: 'Route Prism ingest, realtime, report, config, and OTEL traffic.',
  }),
  Object.freeze({
    name: 'apiKey',
    legacyNames: Object.freeze([]),
    editable: false,
    type: 'secret',
    defaultValue: '',
    allowedValues: 'Prism API key',
    applies: 'Restart Claude Code',
    description: 'Prism API key. Managed by /prism:setup KEY.',
  }),
  Object.freeze({
    name: 'dashboard_url',
    legacyNames: Object.freeze([]),
    editable: false,
    type: 'URL',
    defaultValue: null,
    allowedValues: 'HTTPS URL',
    applies: 'Next command invocation',
    description: 'Dashboard origin reported by the config endpoint during setup.',
  }),
]);

/**
 * Field names this version no longer reads. Dropped from config on every read
 * and removed from disk by the next write.
 *
 * `prismThreshold` was read up to 0.6.1 and removed in 0.6.2. Every version
 * that read it defaulted to 4.0 when it was absent, so deleting it resets a
 * customized threshold on installs still pinned to those versions rather than
 * breaking them.
 *
 * A tombstoned legacy boolean is deliberately not listed here: a tombstone
 * test forbids that identifier from reappearing in any runtime surface, so it
 * stays on disk as an inert unknown key instead of being named for removal.
 */
const DEAD_CONFIG_FIELDS = Object.freeze(['prismThreshold']);

const CONFIG_FIELDS_BY_NAME = new Map(CONFIG_FIELDS.map((field) => [field.name, field]));

function getConfigField(name) {
  return CONFIG_FIELDS_BY_NAME.get(name) || null;
}

function getEditableConfigFields() {
  return CONFIG_FIELDS.filter((field) => field.editable === true);
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

  for (const deadName of DEAD_CONFIG_FIELDS) delete normalized[deadName];

  return normalized;
}

module.exports = {
  CONFIG_FIELDS,
  DEAD_CONFIG_FIELDS,
  getConfigDefaults,
  getConfigField,
  getEditableConfigFields,
  normalizeConfigFields,
};
