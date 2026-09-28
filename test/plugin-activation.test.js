const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  activatePluginVersion,
  activationFailureNotice,
  activatedNotice,
  collectPluginNotices,
  sessionActivationNotice,
  settingsUpdatedNotice,
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
  const fixture = activationFixture({
    syncMetadataFn: (input) => {
      fixture.calls.sync.push(input);
      return { ok: true, restartRequired: true, helperConfigured: true, helperConflict: false };
    },
  });
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

test('a version change refreshed by an effective helper advances the marker without a restart notice', () => {
  const fixture = activationFixture({
    syncMetadataFn: (input) => {
      fixture.calls.sync.push(input);
      return { ok: true, changed: true, restartRequired: false, helperConfigured: true };
    },
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.versionChanged, true);
  assert.equal(result.markerWritten, true);
  assert.equal(result.notice, null);
  assert.equal(result.noticeKind, null);
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

test('reports updated settings, not a version update, when the marker is already current', () => {
  const fixture = activationFixture({
    readActiveVersionFn: () => '1.2.3',
    syncMetadataFn: (input) => {
      fixture.calls.sync.push(input);
      return {
        ok: true,
        changed: true,
        restartRequired: true,
        helperConfigured: true,
        helperConflict: false,
      };
    },
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.versionChanged, false);
  assert.equal(result.notice, settingsUpdatedNotice());
  assert.equal(result.noticeKind, 'settings-updated');
  assert.deepEqual(fixture.calls.writes, []);
});

test('a settings change that the helper refreshes shows no notice when the marker is current', () => {
  const fixture = activationFixture({
    readActiveVersionFn: () => '1.2.3',
    syncMetadataFn: () => ({ ok: true, changed: true, restartRequired: false }),
  });
  const result = activatePluginVersion(fixture.options);

  assert.equal(result.notice, null);
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
  assert.equal(result.noticeKind, 'activation-failure');
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
    syncMetadataFn: () => ({ ok: true, changed: true, restartRequired: true }),
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

test('an activation failure is shown once per session and version', () => {
  const claimed = new Set();
  const claims = [];
  const claimNoticeFn = (input) => {
    claims.push(input);
    const id = `${input.sessionId}|${input.key}`;
    if (claimed.has(id)) return false;
    claimed.add(id);
    return true;
  };
  const failure = {
    currentVersion: '1.2.3',
    notice: activationFailureNotice('1.2.3'),
    noticeKind: 'activation-failure',
  };
  const options = { dataDir: '/plugin/data', sessionId: 'session-a', claimNoticeFn };

  assert.equal(sessionActivationNotice(failure, options), activationFailureNotice('1.2.3'));
  assert.equal(sessionActivationNotice(failure, options), null);
  assert.equal(
    sessionActivationNotice(failure, { ...options, sessionId: 'session-b' }),
    activationFailureNotice('1.2.3'),
  );
  assert.deepEqual(claims[0], {
    dataDir: '/plugin/data',
    sessionId: 'session-a',
    key: 'activation-failure@1.2.3',
  });
});

test('restart notices bypass the per-session claim and a failing claim fails open', () => {
  let claims = 0;
  const activated = {
    currentVersion: '1.2.3',
    notice: activatedNotice('1.2.3'),
    noticeKind: 'activated',
  };
  assert.equal(sessionActivationNotice(activated, {
    sessionId: 'session-a',
    claimNoticeFn: () => {
      claims += 1;
      return false;
    },
  }), activatedNotice('1.2.3'));
  assert.equal(claims, 0);

  assert.equal(sessionActivationNotice({
    currentVersion: '1.2.3',
    notice: activationFailureNotice('1.2.3'),
    noticeKind: 'activation-failure',
  }, {
    sessionId: 'session-a',
    claimNoticeFn: () => {
      throw new Error('unwritable');
    },
  }), activationFailureNotice('1.2.3'));
});

test('SessionStart suppresses a repeated activation failure within the same session', async () => {
  const claimed = new Set();
  const options = {
    source: 'resume',
    dataDir: '/plugin/data',
    sessionId: 'session-a',
    activateFn: () => ({
      currentVersion: '1.2.3',
      notice: activationFailureNotice('1.2.3'),
      noticeKind: 'activation-failure',
    }),
    claimNoticeFn: ({ sessionId, key }) => {
      const id = `${sessionId}|${key}`;
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },
  };

  assert.deepEqual((await collectPluginNotices(options)).notices, [activationFailureNotice('1.2.3')]);
  assert.deepEqual((await collectPluginNotices(options)).notices, []);
});
