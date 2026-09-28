'use strict';

/**
 * How the running Claude Code host treats OTEL settings.
 *
 * From Claude Code 2.1.282, project and local settings can only turn
 * telemetry off: variables that enable export, choose its destination, or
 * capture content are dropped from those layers. Only user, `--settings`, and
 * managed settings (or the launching environment) can turn Prism telemetry on.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { CLAUDE_CODE_CAPABILITY_BOUNDARIES } = require('./claude-capabilities');

const PROJECT_TELEMETRY_IGNORED_FROM = CLAUDE_CODE_CAPABILITY_BOUNDARIES.projectTelemetryIgnored;
const HOST_VERSION_TIMEOUT_MS = 2000;
const OTLP_EXPORTER_PREFIX = 'OTEL_EXPORTER_OTLP_';
const OTLP_IGNORED_SUFFIXES = [
  '_ENDPOINT',
  '_HEADERS',
  '_PROTOCOL',
  '_CERTIFICATE',
  '_CLIENT_KEY',
  '_INSECURE',
];
const IGNORED_EXACT_KEYS = new Set([
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'ENABLE_ENHANCED_TELEMETRY_BETA',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_EXPORTER_PROMETHEUS_HOST',
  'OTEL_EXPORTER_PROMETHEUS_PORT',
]);
const EXPORTER_SELECTORS = new Set([
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
]);
const CONTENT_OFF_KEYS = new Set([
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_TOOL_DETAILS',
]);

const hostVersionCache = new Map();

function parseStableVersion(value) {
  const match = typeof value === 'string' && /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function parseHostVersion(output) {
  const parts = parseStableVersion(output);
  return parts ? parts.join('.') : null;
}

/**
 * Ask the running Claude Code binary for its version. Inside a Claude Code
 * subprocess the host exposes its executable as CLAUDE_CODE_EXECPATH; outside
 * one, fall back to `claude` on PATH. Returns null when neither answers.
 */
function resolveHostVersion({ env = process.env, execFileSyncFn = execFileSync } = {}) {
  const execPath = typeof env.CLAUDE_CODE_EXECPATH === 'string'
    && path.isAbsolute(env.CLAUDE_CODE_EXECPATH)
    ? env.CLAUDE_CODE_EXECPATH
    : null;
  const candidates = execPath ? [execPath, 'claude'] : ['claude'];
  const cacheKey = candidates.join('\0');
  if (execFileSyncFn === execFileSync && hostVersionCache.has(cacheKey)) {
    return hostVersionCache.get(cacheKey);
  }

  let version = null;
  for (const command of candidates) {
    try {
      version = parseHostVersion(execFileSyncFn(command, ['--version'], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: HOST_VERSION_TIMEOUT_MS,
      }));
    } catch {
      version = null;
    }
    if (version) break;
  }
  if (execFileSyncFn === execFileSync) hostVersionCache.set(cacheKey, version);
  return version;
}

// An unknown host is treated as current, so a silently dropped projection is
// reported rather than assumed to work.
function hostIgnoresProjectTelemetry(hostVersion) {
  const comparison = compareVersions(hostVersion, PROJECT_TELEMETRY_IGNORED_FROM);
  return comparison === null || comparison >= 0;
}

function scopeCanEnableTelemetry(scope, hostVersion) {
  if (scope === 'user') return true;
  if (scope !== 'project' && scope !== 'local') return false;
  return !hostIgnoresProjectTelemetry(hostVersion);
}

function isIgnoredInProjectSettings(key) {
  const name = String(key).toUpperCase();
  if (IGNORED_EXACT_KEYS.has(name)) return true;
  return name.startsWith(OTLP_EXPORTER_PREFIX)
    && OTLP_IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function isOffValue(value) {
  return typeof value === 'string' && /^(0|false)$/i.test(value.trim());
}

/**
 * Whether a project or local settings value still reaches the process on a
 * host that ignores project telemetry: only values that turn something off.
 */
function appliesFromProjectSettings(key, value) {
  if (!isIgnoredInProjectSettings(key)) return true;
  const name = String(key).toUpperCase();
  if (EXPORTER_SELECTORS.has(name)) return typeof value === 'string' && value.trim() === 'none';
  if (CONTENT_OFF_KEYS.has(name)) return isOffValue(value);
  return false;
}

function isTruthyFlag(value) {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * The telemetry switch as this Claude Code session actually applied it.
 * Hooks and tool subprocesses inherit CLAUDE_CODE_ENABLE_TELEMETRY but not the
 * OTEL_* exporter variables, so only the switch is observable here.
 */
function readSessionTelemetry(env = process.env) {
  const observable = env.CLAUDECODE === '1';
  return {
    observable,
    enabled: observable ? isTruthyFlag(env.CLAUDE_CODE_ENABLE_TELEMETRY) : null,
  };
}

function describeHost(hostVersion) {
  return hostVersion ? `Claude Code ${hostVersion}` : 'Claude Code (version unknown)';
}

function userScopeReinstallCommands(scope) {
  return [
    `claude plugin uninstall prism@optra-prism --scope ${scope}`,
    'claude plugin install prism@optra-prism --scope user',
  ];
}

function withheldTelemetrySummary({ scope, hostVersion }) {
  return `${describeHost(hostVersion)} ignores telemetry variables in ${scope} settings `
    + `(Claude Code ${PROJECT_TELEMETRY_IGNORED_FROM}+), so Prism sends no OTEL telemetry `
    + 'in this project. Prompt and hook capture continue.';
}

function withheldTelemetryRemediation({ scope }) {
  return `Reinstall Prism at user scope, then run /prism:setup KEY: ${userScopeReinstallCommands(scope).join(' && ')}`;
}

function withheldTelemetryNotice({ scope, hostVersion }) {
  return `Prism is installed at ${scope} scope, where ${describeHost(hostVersion)} ignores `
    + 'telemetry settings, so no OTEL telemetry is collected in this project. '
    + 'Run `/prism:doctor` for how to collect it.';
}

function optOutUsage(optOutFile) {
  return `To run a session without Prism: claude --settings ${optOutFile}`;
}

module.exports = {
  PROJECT_TELEMETRY_IGNORED_FROM,
  optOutUsage,
  userScopeReinstallCommands,
  withheldTelemetryNotice,
  withheldTelemetryRemediation,
  withheldTelemetrySummary,
  appliesFromProjectSettings,
  compareVersions,
  hostIgnoresProjectTelemetry,
  isIgnoredInProjectSettings,
  parseHostVersion,
  readSessionTelemetry,
  resolveHostVersion,
  scopeCanEnableTelemetry,
};
