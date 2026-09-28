'use strict';

const {
  checkForPluginUpdate,
  compareStableSemVer,
  readActiveVersion,
  readCurrentPluginVersion,
  writeActiveVersion,
} = require('./plugin-update');
const { syncPluginVersionMetadata } = require('./settings');
const { readSessionTelemetry, withheldTelemetryNotice } = require('./host-telemetry');
const { claimSessionNotice } = require('./session-notice');

// Sessions that start a new Claude Code process; clear and compact reuse one.
const PROCESS_START_SOURCES = new Set(['startup', 'resume']);

function activatedNotice(version) {
  return `Prism v${version} is active. `
    + 'Restart Claude Code to apply its telemetry settings.';
}

function settingsUpdatedNotice() {
  return 'Prism updated its telemetry settings. '
    + 'Restart Claude Code to apply them.';
}

function activationFailureNotice(version) {
  return `Prism v${version} is active, but its telemetry metadata could not be prepared. `
    + 'Run `/prism:doctor`, then restart Claude Code.';
}

function updateAvailableNotice(version) {
  return `Prism v${version} is available. `
    + 'Update the plugin, then run `/reload-plugins` or restart Claude Code.';
}

function activatePluginVersion({
  pluginRoot,
  dataDir,
  projectDir,
  readCurrentVersionFn = readCurrentPluginVersion,
  readActiveVersionFn = readActiveVersion,
  writeActiveVersionFn = writeActiveVersion,
  syncMetadataFn = syncPluginVersionMetadata,
} = {}) {
  const currentVersion = readCurrentVersionFn({ pluginRoot });
  const previousVersion = readActiveVersionFn(dataDir);
  if (!currentVersion) {
    return {
      currentVersion: null,
      previousVersion,
      staleRuntime: false,
      versionChanged: false,
      metadataSynced: false,
      markerWritten: false,
      notice: null,
    };
  }

  if (compareStableSemVer(previousVersion, currentVersion) === 1) {
    return {
      currentVersion,
      previousVersion,
      staleRuntime: true,
      versionChanged: false,
      metadataSynced: false,
      markerWritten: false,
      notice: null,
    };
  }

  const versionChanged = previousVersion !== null && previousVersion !== currentVersion;
  let metadata;
  try {
    metadata = syncMetadataFn({
      pluginRoot,
      dataDir,
      projectDir,
      pluginVersion: currentVersion,
    });
  } catch {
    metadata = { ok: false };
  }

  if (!metadata || metadata.ok !== true) {
    return {
      currentVersion,
      previousVersion,
      staleRuntime: false,
      versionChanged,
      metadataSynced: false,
      markerWritten: false,
      notice: previousVersion !== null ? activationFailureNotice(currentVersion) : null,
      noticeKind: previousVersion !== null ? 'activation-failure' : null,
    };
  }

  const markerWritten = previousVersion === currentVersion
    || writeActiveVersionFn(dataDir, currentVersion);
  if (!markerWritten) {
    return {
      currentVersion,
      previousVersion,
      staleRuntime: false,
      versionChanged,
      metadataSynced: true,
      markerWritten: false,
      helperConfigured: metadata.helperConfigured !== false,
      helperConflict: metadata.helperConflict === true,
      notice: activationFailureNotice(currentVersion),
      noticeKind: 'activation-failure',
    };
  }

  const telemetryWithheld = metadata.telemetryWithheld === true;
  const restartRequired = !telemetryWithheld
    && previousVersion !== null
    && metadata.restartRequired === true;
  let noticeKind = null;
  if (restartRequired) noticeKind = versionChanged ? 'activated' : 'settings-updated';
  return {
    currentVersion,
    previousVersion,
    staleRuntime: false,
    versionChanged,
    metadataSynced: true,
    markerWritten,
    helperConfigured: metadata.helperConfigured !== false,
    helperConflict: metadata.helperConflict === true,
    telemetryWithheld,
    scope: metadata.scope || null,
    hostVersion: metadata.hostVersion === undefined ? null : metadata.hostVersion,
    notice: noticeFor(noticeKind, currentVersion),
    noticeKind,
  };
}

function noticeFor(kind, version) {
  if (kind === 'activated') return activatedNotice(version);
  if (kind === 'settings-updated') return settingsUpdatedNotice();
  return null;
}

// A failure persists until repaired, so it is shown once per session rather
// than on every SessionStart and UserPromptSubmit.
function sessionActivationNotice(activation, {
  dataDir,
  sessionId,
  claimNoticeFn = claimSessionNotice,
} = {}) {
  if (!activation || !activation.notice) return null;
  if (activation.noticeKind !== 'activation-failure') return activation.notice;
  try {
    return claimNoticeFn({
      dataDir,
      sessionId,
      key: `activation-failure@${activation.currentVersion}`,
    }) ? activation.notice : null;
  } catch {
    return activation.notice;
  }
}

async function collectPluginNotices({
  source,
  pluginRoot,
  dataDir,
  projectDir,
  sessionId,
  activateFn = activatePluginVersion,
  checkUpdateFn = checkForPluginUpdate,
  claimNoticeFn = claimSessionNotice,
  env = process.env,
} = {}) {
  const notices = [];
  let activation = null;
  try {
    activation = activateFn({ pluginRoot, dataDir, projectDir });
    const notice = sessionActivationNotice(activation, { dataDir, sessionId, claimNoticeFn });
    if (notice) notices.push(notice);
  } catch {}

  // Telemetry exported from the launching shell still counts as collected.
  if (activation
    && activation.telemetryWithheld === true
    && PROCESS_START_SOURCES.has(source)
    && readSessionTelemetry(env).enabled !== true) {
    notices.push(withheldTelemetryNotice({
      scope: activation.scope,
      hostVersion: activation.hostVersion,
    }));
  }

  let update = null;
  if (source === 'startup') {
    try {
      update = await checkUpdateFn({ pluginRoot, dataDir });
      if (update && update.updateAvailable && update.latestVersion) {
        notices.push(updateAvailableNotice(update.latestVersion));
      }
    } catch {}
  }

  return { notices, activation, update };
}

module.exports = {
  activatePluginVersion,
  activatedNotice,
  activationFailureNotice,
  collectPluginNotices,
  sessionActivationNotice,
  settingsUpdatedNotice,
  updateAvailableNotice,
};
