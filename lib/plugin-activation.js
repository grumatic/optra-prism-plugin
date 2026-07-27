'use strict';

const {
  checkForPluginUpdate,
  compareStableSemVer,
  readActiveVersion,
  readCurrentPluginVersion,
  writeActiveVersion,
} = require('./plugin-update');
const { syncPluginVersionMetadata } = require('./settings');

function activatedNotice(version) {
  return `Prism has been updated to v${version}. `
    + 'Restart Claude Code to apply the new telemetry metadata immediately.';
}

function activationFailureNotice(version) {
  return `Prism v${version} is active, but its telemetry metadata could not be prepared. `
    + 'Run `/prism:doctor`, then restart Claude Code.';
}

function updateAvailableNotice(version) {
  return `Prism v${version} is available. `
    + 'Update the plugin, run `/reload-plugins`, then restart Claude Code.';
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
    };
  }

  const restartRequired = versionChanged
    || (previousVersion === currentVersion && metadata.changed === true);
  return {
    currentVersion,
    previousVersion,
    staleRuntime: false,
    versionChanged,
    metadataSynced: true,
    markerWritten,
    helperConfigured: metadata.helperConfigured !== false,
    helperConflict: metadata.helperConflict === true,
    notice: restartRequired ? activatedNotice(currentVersion) : null,
  };
}

async function collectPluginNotices({
  source,
  pluginRoot,
  dataDir,
  projectDir,
  activateFn = activatePluginVersion,
  checkUpdateFn = checkForPluginUpdate,
} = {}) {
  const notices = [];
  let activation = null;
  try {
    activation = activateFn({ pluginRoot, dataDir, projectDir });
    if (activation && activation.notice) notices.push(activation.notice);
  } catch {}

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
  updateAvailableNotice,
};
