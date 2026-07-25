const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  activatePluginVersion,
  activationFailureNotice,
  activatedNotice,
  collectPluginNotices,
  updateAvailableNotice,
} = require('../lib/plugin-activation');

function activationFixture(overrides = {}) {
  const calls = { sync: [], writes: [] };
  const options = {
    pluginRoot: '/plugin/root',
    dataDir: '/plugin/data',
    projectDir: '/project',
    readCurrentVersionFn: () => '1.2.3',
    readActiveVersionFn: () => '1.2.2',
    syncMetadataFn: (input) => {
      calls.sync.push(input);
      return { ok: true, helperConfigured: true, helperConflict: false };
    },
    writeActiveVersionFn: (dataDir, version) => {
      calls.writes.push({ dataDir, version });
      return true;
    },
    ...overrides,
  };
  return { calls, options };
}

test('projects metadata before advancing the active version and recommending restart', () => {
  const fixture = activationFixture();
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.versionChanged, true);
  assert.equal(result.metadataSynced, true);
  assert.equal(result.markerWritten, true);
  assert.equal(result.notice, activatedNotice('1.2.3'));
  assert.deepEqual(fixture.calls.sync, [{
    pluginRoot: '/plugin/root',
    dataDir: '/plugin/data',
    projectDir: '/project',
    pluginVersion: '1.2.3',
  }]);
  assert.deepEqual(fixture.calls.writes, [{
    dataDir: '/plugin/data',
    version: '1.2.3',
  }]);
});

test('checks metadata idempotently even when another scope already advanced the shared marker', () => {
  const fixture = activationFixture({
    readActiveVersionFn: () => '1.2.3',
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.versionChanged, false);
  assert.equal(result.notice, null);
  assert.equal(fixture.calls.sync.length, 1);
  assert.deepEqual(fixture.calls.writes, []);
});

test('still recommends restart when the shared marker advanced before this scope was projected', () => {
  const fixture = activationFixture({
    readActiveVersionFn: () => '1.2.3',
    syncMetadataFn: (input) => {
      fixture.calls.sync.push(input);
      return {
        ok: true,
        changed: true,
        helperConfigured: true,
        helperConflict: false,
      };
    },
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.versionChanged, false);
  assert.equal(result.notice, activatedNotice('1.2.3'));
  assert.deepEqual(fixture.calls.writes, []);
});

test('does not advance the marker when metadata projection fails', () => {
  const fixture = activationFixture({
    syncMetadataFn: () => ({ ok: false }),
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.metadataSynced, false);
  assert.equal(result.markerWritten, false);
  assert.match(result.notice, /could not be prepared/);
  assert.deepEqual(fixture.calls.writes, []);
});

test('reports metadata failure when the shared marker is already current', () => {
  const fixture = activationFixture({
    readActiveVersionFn: () => '1.2.3',
    syncMetadataFn: () => ({ ok: false, reason: 'effective OTEL headers overridden' }),
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.versionChanged, false);
  assert.equal(result.metadataSynced, false);
  assert.equal(result.markerWritten, false);
  assert.equal(result.notice, activationFailureNotice('1.2.3'));
  assert.deepEqual(fixture.calls.writes, []);
});

test('does not let an older plugin root downgrade newer shared activation state', () => {
  const fixture = activationFixture({
    readCurrentVersionFn: () => '1.2.2',
    readActiveVersionFn: () => '1.2.3',
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.staleRuntime, true);
  assert.equal(result.versionChanged, false);
  assert.equal(result.metadataSynced, false);
  assert.equal(result.markerWritten, false);
  assert.equal(result.notice, null);
  assert.deepEqual(fixture.calls.sync, []);
  assert.deepEqual(fixture.calls.writes, []);
});

test('reports activation failure instead of success when marker publication fails', () => {
  const fixture = activationFixture({
    writeActiveVersionFn: (dataDir, version) => {
      fixture.calls.writes.push({ dataDir, version });
      return false;
    },
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.staleRuntime, false);
  assert.equal(result.metadataSynced, true);
  assert.equal(result.markerWritten, false);
  assert.equal(result.notice, activationFailureNotice('1.2.3'));
  assert.notEqual(result.notice, activatedNotice('1.2.3'));
  assert.deepEqual(fixture.calls.writes, [{
    dataDir: '/plugin/data',
    version: '1.2.3',
  }]);
});

test('first activation seeds the marker without an update restart notice', () => {
  const fixture = activationFixture({
    readActiveVersionFn: () => null,
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.versionChanged, false);
  assert.equal(result.notice, null);
  assert.equal(result.markerWritten, true);
});

test('startup combines activation and latest-version notices in deterministic order', async () => {
  const result = await collectPluginNotices({
    source: 'startup',
    pluginRoot: '/plugin/root',
    dataDir: '/plugin/data',
    projectDir: '/project',
    activateFn: () => ({ notice: activatedNotice('1.2.3') }),
    checkUpdateFn: async () => ({
      updateAvailable: true,
      latestVersion: '1.3.0',
    }),
  });

  assert.deepEqual(result.notices, [
    activatedNotice('1.2.3'),
    updateAvailableNotice('1.3.0'),
  ]);
});

test('non-startup sources never perform a network update check', async () => {
  let checks = 0;
  const result = await collectPluginNotices({
    source: 'resume',
    activateFn: () => ({ notice: null }),
    checkUpdateFn: async () => {
      checks += 1;
      return { updateAvailable: true, latestVersion: '9.9.9' };
    },
  });

  assert.equal(checks, 0);
  assert.deepEqual(result.notices, []);
});
