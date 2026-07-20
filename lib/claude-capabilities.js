'use strict';

/**
 * Claude Code feature boundaries used by Prism.
 *
 * These values describe individual capabilities, not a single minimum host
 * version for the whole Plugin. Runtime code must still verify that the
 * expected Hook field or OTEL attribute is actually present.
 */
const CLAUDE_CODE_CAPABILITY_BOUNDARIES = Object.freeze({
  stopResponse: '2.1.47',
  // Conservative floor inferred from changelog evidence; runtime shape-gates it.
  cwdChanged: '2.1.83',
  toolCorrelation: '2.1.119',
  numericAttributesFrom: '2.1.122',
  coreEvents: '2.1.161',
  nativeResponse: '2.1.193',
  // Declarative reviewed boundary, not a product runtime semver gate.
  promptCorrelation: '2.1.196',
});

module.exports = {
  CLAUDE_CODE_CAPABILITY_BOUNDARIES,
};
