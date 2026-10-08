require('./helpers/isolate-claude-env');

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, beforeEach, test } = require('node:test');

const {
  INVENTORY_FILENAME,
  MAX_ROOTS,
  REGISTER_INTERVAL_MS,
  inventoryPath,
  readInventory,
  registerRoot,
  removeRoots,
  verifyOtherRoots,
  verifyRoot,
} = require('../lib/install-inventory');
const { updateJsonAtomic } = require('../lib/locked-json');

const INVENTORY_MODULE = path.resolve(__dirname, '..', 'lib', 'install-inventory.js');
const created = [];
let sandbox;
let home;

function realTemp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  sandbox = realTemp('prism-inventory-');
  home = path.join(sandbox, 'home');
  fs.mkdirSync(home, { recursive: true });
});

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function prismDir() {
  const dir = path.join(home, '.prism');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readInventoryFile() {
  return JSON.parse(fs.readFileSync(inventoryPath(home), 'utf8'));
}

function writeInventoryFile(value) {
  prismDir();
  fs.writeFileSync(inventoryPath(home), typeof value === 'string' ? value : JSON.stringify(value));
}

function configRoot(name) {
  const root = path.join(sandbox, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function installPrism(root, entries = [{ scope: 'user', installPath: path.join(root, 'plugins', 'cache') }]) {
  const registry = path.join(root, 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ version: 2, plugins: { 'prism@optra-prism': entries } }));
  return registry;
}

const NOW = Date.parse('2026-10-08T00:00:00.000Z');

test('registration never creates ~/.prism and needs it to exist', () => {
  const root = configRoot('cfg-a');
  assert.deepEqual(registerRoot({ configRoot: root, homeDir: home, now: NOW }), {
    registered: false,
    reason: 'no-prism-dir',
  });
  assert.equal(fs.existsSync(path.join(home, '.prism')), false);
});

test('registration writes a 0600 canonical inventory and is throttled to once a day', () => {
  prismDir();
  const root = configRoot('cfg-a');
  const alias = path.join(sandbox, 'alias');
  fs.symlinkSync(root, alias);

  assert.deepEqual(registerRoot({ configRoot: alias, homeDir: home, now: NOW }), {
    registered: true,
    reason: null,
  });
  const file = inventoryPath(home);
  assert.equal(path.basename(file), INVENTORY_FILENAME);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const written = readInventoryFile();
  assert.deepEqual(written, {
    version: 1,
    overflow: false,
    roots: { [root]: { firstSeen: new Date(NOW).toISOString(), lastSeen: new Date(NOW).toISOString() } },
  });
  assert.equal(JSON.stringify(written).includes('apiKey'), false);

  const before = fs.readFileSync(file, 'utf8');
  const inode = fs.statSync(file).ino;
  assert.deepEqual(registerRoot({
    configRoot: root, homeDir: home, now: NOW + REGISTER_INTERVAL_MS - 1,
  }), { registered: false, reason: 'fresh' });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).ino, inode);

  const later = NOW + REGISTER_INTERVAL_MS + 1000;
  assert.equal(registerRoot({ configRoot: root, homeDir: home, now: later }).registered, true);
  const refreshed = readInventoryFile().roots[root];
  assert.equal(refreshed.firstSeen, new Date(NOW).toISOString());
  assert.equal(refreshed.lastSeen, new Date(later).toISOString());
  assert.deepEqual(
    fs.readdirSync(path.join(home, '.prism')).filter((name) => name.includes('lock') || name.endsWith('.tmp')),
    [],
  );
});

test('the inventory is capped without eviction and records overflow instead', () => {
  prismDir();
  const roots = {};
  for (let index = 0; index < MAX_ROOTS; index++) {
    roots[path.join(sandbox, `root-${String(index).padStart(2, '0')}`)] = {
      firstSeen: new Date(NOW).toISOString(),
      lastSeen: new Date(NOW).toISOString(),
    };
  }
  writeInventoryFile({ version: 1, overflow: false, roots });
  const extra = configRoot('one-too-many');

  const result = registerRoot({ configRoot: extra, homeDir: home, now: NOW });
  assert.equal(result.registered, false);
  assert.equal(result.reason, 'overflow');
  const stored = readInventoryFile();
  assert.equal(stored.overflow, true);
  assert.deepEqual(Object.keys(stored.roots).sort(), Object.keys(roots).sort());
  assert.equal(Object.hasOwn(stored.roots, extra), false);

  // A later attempt neither rewrites the file nor evicts anything.
  const bytes = fs.readFileSync(inventoryPath(home), 'utf8');
  assert.equal(registerRoot({ configRoot: extra, homeDir: home, now: NOW + 1 }).reason, 'overflow');
  assert.equal(fs.readFileSync(inventoryPath(home), 'utf8'), bytes);

  // A root that is already listed can still be refreshed once it is stale.
  const known = Object.keys(roots)[0];
  assert.equal(
    registerRoot({ configRoot: known, homeDir: home, now: NOW + REGISTER_INTERVAL_MS + 1 }).registered,
    true,
  );
  assert.equal(readInventoryFile().overflow, true);
});

test('a corrupt inventory is reported, never rewritten, and skipped by registration', () => {
  const root = configRoot('cfg-a');
  for (const contents of [
    '{not json',
    JSON.stringify({ version: 2, overflow: false, roots: {} }),
    JSON.stringify({ version: 1, overflow: 'yes', roots: {} }),
    JSON.stringify({ version: 1, overflow: false, roots: [] }),
    JSON.stringify([]),
  ]) {
    writeInventoryFile(contents);
    const bytes = fs.readFileSync(inventoryPath(home), 'utf8');

    assert.equal(readInventory({ homeDir: home }).status, 'corrupt', contents);
    assert.deepEqual(registerRoot({ configRoot: root, homeDir: home, now: NOW }), {
      registered: false,
      reason: 'corrupt',
    });
    const removal = removeRoots({ rootsToRemove: [root], homeDir: home });
    assert.equal(removal.ok, false);
    assert.equal(fs.readFileSync(inventoryPath(home), 'utf8'), bytes);
    assert.equal(verifyOtherRoots({ configRoot: root, homeDir: home }).inventory.condition, 'corrupt');
  }

  // A symlinked inventory file is never followed.
  fs.rmSync(inventoryPath(home));
  const outside = path.join(sandbox, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ version: 1, overflow: false, roots: {} }));
  fs.symlinkSync(outside, inventoryPath(home));
  assert.equal(readInventory({ homeDir: home }).status, 'corrupt');
  assert.equal(registerRoot({ configRoot: root, homeDir: home, now: NOW }).reason, 'corrupt');
});

test('a missing inventory is empty, and the file is untrusted input', () => {
  assert.equal(readInventory({ homeDir: home }).status, 'ok');
  assert.equal(readInventory({ homeDir: home }).roots.size, 0);

  const real = configRoot('real');
  writeInventoryFile({
    version: 1,
    overflow: false,
    surprise: 'ignored',
    roots: {
      [real]: { firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-02-01T00:00:00.000Z', extra: 1 },
      'relative/path': { firstSeen: 'x', lastSeen: 'y' },
      [`${sandbox}/nul\0byte`]: {},
      '': {},
      '~/tilde': {},
    },
  });
  const inventory = readInventory({ homeDir: home });
  assert.equal(inventory.status, 'ok');
  assert.deepEqual([...inventory.roots.keys()], [real]);
  assert.deepEqual(inventory.roots.get(real), {
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-02-01T00:00:00.000Z',
  });
});

test('keys are canonicalized on read and duplicates are merged', () => {
  const real = configRoot('real');
  const alias = path.join(sandbox, 'alias');
  fs.symlinkSync(real, alias);
  writeInventoryFile({
    version: 1,
    overflow: false,
    roots: {
      [real]: { firstSeen: '2026-03-01T00:00:00.000Z', lastSeen: '2026-03-05T00:00:00.000Z' },
      [alias]: { firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-02-01T00:00:00.000Z' },
      [`${real}/../real/`]: { firstSeen: '2026-02-01T00:00:00.000Z', lastSeen: '2026-04-01T00:00:00.000Z' },
    },
  });
  const inventory = readInventory({ homeDir: home });
  assert.deepEqual([...inventory.roots.keys()], [real]);
  assert.deepEqual(inventory.roots.get(real), {
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-04-01T00:00:00.000Z',
  });

  // The next write persists the merged form.
  registerRoot({ configRoot: configRoot('other'), homeDir: home, now: NOW });
  assert.deepEqual(
    Object.keys(readInventoryFile().roots).sort(),
    [real, path.join(sandbox, 'other')].sort(),
  );
});

test('pruning removes only the requested roots and nothing inside them', () => {
  prismDir();
  const keep = configRoot('keep');
  const gone = configRoot('gone');
  fs.writeFileSync(path.join(gone, 'marker'), 'untouched\n');
  registerRoot({ configRoot: keep, homeDir: home, now: NOW });
  registerRoot({ configRoot: gone, homeDir: home, now: NOW });

  const removal = removeRoots({ rootsToRemove: [gone], homeDir: home });
  assert.equal(removal.ok, true);
  assert.deepEqual(removal.removed, [gone]);
  assert.deepEqual(Object.keys(readInventoryFile().roots), [keep]);
  assert.equal(fs.readFileSync(path.join(gone, 'marker'), 'utf8'), 'untouched\n');

  // Nothing to remove: no write, and no file is created when none existed.
  const bytes = fs.readFileSync(inventoryPath(home), 'utf8');
  assert.deepEqual(removeRoots({ rootsToRemove: [gone], homeDir: home }), { ok: true, removed: [] });
  assert.equal(fs.readFileSync(inventoryPath(home), 'utf8'), bytes);
  fs.rmSync(inventoryPath(home));
  assert.deepEqual(removeRoots({ rootsToRemove: [keep], homeDir: home }), { ok: true, removed: [] });
  assert.equal(fs.existsSync(inventoryPath(home)), false);
});

test('pruning re-verifies each root under the lock and keeps one that is no longer absent', () => {
  prismDir();
  const stale = configRoot('stale');
  const gone = configRoot('gone');
  registerRoot({ configRoot: stale, homeDir: home, now: NOW });
  registerRoot({ configRoot: gone, homeDir: home, now: NOW });
  // Both verified as absent earlier; `stale` gained a Prism install since.
  assert.equal(verifyRoot(stale).state, 'absent');
  installPrism(stale);

  const removal = removeRoots({ rootsToRemove: [stale, gone], homeDir: home });

  assert.equal(removal.ok, true);
  assert.deepEqual(removal.removed, [gone]);
  assert.deepEqual(Object.keys(readInventoryFile().roots), [stale]);

  // An unverifiable root is never pruned either.
  fs.writeFileSync(path.join(stale, 'plugins', 'installed_plugins.json'), '{nope');
  assert.deepEqual(removeRoots({ rootsToRemove: [stale], homeDir: home }), { ok: true, removed: [] });
  assert.deepEqual(Object.keys(readInventoryFile().roots), [stale]);
});

test('every successful write leaves installs.json at 0600', () => {
  prismDir();
  const first = configRoot('first');
  const second = configRoot('second');
  registerRoot({ configRoot: first, homeDir: home, now: NOW });
  const file = inventoryPath(home);

  fs.chmodSync(file, 0o644);
  assert.equal(registerRoot({ configRoot: second, homeDir: home, now: NOW }).registered, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.chmodSync(file, 0o666);
  assert.equal(removeRoots({ rootsToRemove: [second], homeDir: home }).ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(readInventoryFile().roots), [first]);

  // A symlinked inventory is still never rewritten or chmod-ed through.
  const target = path.join(sandbox, 'target.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, overflow: false, roots: {} }), { mode: 0o644 });
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  assert.equal(registerRoot({ configRoot: second, homeDir: home, now: NOW }).registered, false);
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
});

test('concurrent registration from several processes loses no registered root', async () => {
  prismDir();
  const names = Array.from({ length: 8 }, (_, index) => `proc-root-${index}`);
  const children = names.map((name) => new Promise((resolve, reject) => {
    const script = `
      const { registerRoot } = require(${JSON.stringify(INVENTORY_MODULE)});
      const result = registerRoot({ configRoot: process.argv[1], homeDir: process.argv[2], now: ${NOW} });
      process.stdout.write(JSON.stringify(result));
    `;
    const child = spawn(process.execPath, ['-e', script, configRoot(name), home], {
      env: { ...process.env, HOME: home },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  }));
  const results = await Promise.all(children);

  // The lock allows a few attempts; a root that lost the race reports why and
  // is registered by its next prompt. Everything that succeeded must be present.
  const present = Object.keys(readInventoryFile().roots);
  const registered = names
    .map((name, index) => ({ name, result: results[index] }))
    .filter(({ result }) => result.registered);
  assert.ok(registered.length >= 1);
  for (const { name } of registered) {
    assert.ok(present.includes(path.join(sandbox, name)), `${name} lost from the inventory`);
  }
  for (const result of results.filter((entry) => !entry.registered)) {
    assert.match(result.reason, /locked|concurrently/);
  }
  assert.equal(fs.readdirSync(path.join(home, '.prism')).some((name) => name.endsWith('.lock')), false);
});

// ─── verification ───

test('a root with a Prism registry entry is installed, local-path installs included', () => {
  const inCache = configRoot('in-cache');
  installPrism(inCache);
  assert.equal(verifyRoot(inCache).state, 'installed');

  const local = configRoot('local-path');
  installPrism(local, [{ scope: 'user', installPath: path.join(sandbox, 'checkout') }]);
  assert.equal(verifyRoot(local).state, 'installed');

  const mixed = configRoot('mixed');
  installPrism(mixed, [{ scope: 'user' }, { scope: 'user', installPath: '/abs/path' }]);
  assert.equal(verifyRoot(mixed).state, 'installed');
});

test('a missing root, registry, or entry is absent', () => {
  assert.equal(verifyRoot(path.join(sandbox, 'does-not-exist')).state, 'absent');

  const noRegistry = configRoot('no-registry');
  assert.equal(verifyRoot(noRegistry).state, 'absent');

  const noEntry = configRoot('no-entry');
  fs.mkdirSync(path.join(noEntry, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(noEntry, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'other@example': [{ scope: 'user', installPath: '/x' }] } }),
  );
  assert.equal(verifyRoot(noEntry).state, 'absent');

  const emptyArray = configRoot('empty-array');
  installPrism(emptyArray, []);
  assert.equal(verifyRoot(emptyArray).state, 'absent');

  const noPlugins = configRoot('no-plugins');
  fs.mkdirSync(path.join(noPlugins, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(noPlugins, 'plugins', 'installed_plugins.json'), '{"version":2}');
  assert.equal(verifyRoot(noPlugins).state, 'absent');

  const fileAsRoot = path.join(sandbox, 'a-file');
  fs.writeFileSync(fileAsRoot, 'x');
  assert.equal(verifyRoot(path.join(fileAsRoot, 'child')).state, 'absent');
});

test('anything unexpected is unverifiable', () => {
  const symlinkedRegistry = configRoot('symlinked-registry');
  const realRegistry = installPrism(configRoot('registry-target'));
  fs.mkdirSync(path.join(symlinkedRegistry, 'plugins'), { recursive: true });
  fs.symlinkSync(realRegistry, path.join(symlinkedRegistry, 'plugins', 'installed_plugins.json'));
  assert.equal(verifyRoot(symlinkedRegistry).state, 'unverifiable');

  const unparsable = configRoot('unparsable');
  fs.mkdirSync(path.join(unparsable, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(unparsable, 'plugins', 'installed_plugins.json'), '{nope');
  assert.equal(verifyRoot(unparsable).state, 'unverifiable');

  const notObject = configRoot('not-object');
  fs.mkdirSync(path.join(notObject, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(notObject, 'plugins', 'installed_plugins.json'), '[]');
  assert.equal(verifyRoot(notObject).state, 'unverifiable');

  const badEntries = configRoot('bad-entries');
  installPrism(badEntries, [{ scope: 'user' }, { scope: 'user', installPath: 'relative/path' }]);
  assert.equal(verifyRoot(badEntries).state, 'unverifiable');

  const notArray = configRoot('not-array');
  fs.mkdirSync(path.join(notArray, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(notArray, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'prism@optra-prism': { scope: 'user' } } }),
  );
  assert.equal(verifyRoot(notArray).state, 'unverifiable');

  const pluginsNotObject = configRoot('plugins-not-object');
  fs.mkdirSync(path.join(pluginsNotObject, 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginsNotObject, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: [] }),
  );
  assert.equal(verifyRoot(pluginsNotObject).state, 'unverifiable');

  const rootIsFile = path.join(sandbox, 'root-is-file');
  fs.writeFileSync(rootIsFile, 'x');
  assert.equal(verifyRoot(rootIsFile).state, 'unverifiable');

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const unreadable = configRoot('unreadable');
    const registry = installPrism(unreadable);
    fs.chmodSync(registry, 0o000);
    try {
      assert.equal(verifyRoot(unreadable).state, 'unverifiable');
    } finally {
      fs.chmodSync(registry, 0o600);
    }
  }
});

test('the default root is probed without an inventory entry and the current root is excluded', () => {
  const current = configRoot('current');
  installPrism(current);
  const defaultRoot = path.join(home, '.claude');
  installPrism(defaultRoot);

  const verification = verifyOtherRoots({ configRoot: current, homeDir: home });
  assert.deepEqual(verification.roots.map((entry) => [entry.root, entry.state]), [
    [defaultRoot, 'installed'],
  ]);
  assert.equal(verification.keepsPrismDir, true);
  assert.deepEqual(verification.authority, { blockingRoots: [defaultRoot], inventory: 'ok' });

  // From the default root's point of view, only the inventory roots remain.
  const fromDefault = verifyOtherRoots({ configRoot: defaultRoot, homeDir: home });
  assert.deepEqual(fromDefault.roots, []);
  assert.equal(fromDefault.keepsPrismDir, false);
});

test('the current root reached through a symlink alias is not counted as another root', () => {
  prismDir();
  const real = configRoot('real-cfg');
  installPrism(real);
  const alias = path.join(sandbox, 'alias-cfg');
  fs.symlinkSync(real, alias);
  writeInventoryFile({
    version: 1,
    overflow: false,
    roots: {
      [alias]: { firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
    },
  });

  for (const current of [real, alias]) {
    const verification = verifyOtherRoots({ configRoot: current, homeDir: home });
    assert.equal(verification.roots.some((entry) => entry.root === real), false);
    assert.equal(verification.keepsPrismDir, false, current);
  }
});

test('installed, unverifiable, corrupt, and overflowed states keep ~/.prism; absent does not', () => {
  prismDir();
  const current = configRoot('current');
  const other = configRoot('other');

  const stateFor = () => verifyOtherRoots({ configRoot: current, homeDir: home });
  writeInventoryFile({ version: 1, overflow: false, roots: { [other]: {} } });
  assert.equal(stateFor().keepsPrismDir, false);
  assert.deepEqual(stateFor().absent, [other, path.join(home, '.claude')].sort());

  installPrism(other);
  assert.equal(stateFor().keepsPrismDir, true);
  assert.deepEqual(stateFor().authority.blockingRoots, [other]);

  fs.writeFileSync(path.join(other, 'plugins', 'installed_plugins.json'), '{nope');
  assert.equal(stateFor().keepsPrismDir, true);
  assert.equal(stateFor().roots.find((entry) => entry.root === other).state, 'unverifiable');

  fs.rmSync(path.join(other, 'plugins'), { recursive: true });
  writeInventoryFile({ version: 1, overflow: true, roots: { [other]: {} } });
  assert.equal(stateFor().keepsPrismDir, true);
  assert.equal(stateFor().inventory.condition, 'overflow');

  writeInventoryFile('{corrupt');
  assert.equal(stateFor().keepsPrismDir, true);
  assert.equal(stateFor().inventory.condition, 'corrupt');
});

// ─── generic lock and compare-and-swap helper ───

const jsonOptions = (file, extra = {}) => ({
  noun: 'sample',
  readSnapshot: () => {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    return {
      value: text === null ? {} : JSON.parse(text),
      signature: { mode: 0o600, text },
    };
  },
  signaturesMatch: (left, right) => left.text === right.text,
  ...extra,
});

test('the lock helper does not create a missing parent directory unless asked to', () => {
  const missing = path.join(sandbox, 'no-such-dir', 'data.json');
  const refused = updateJsonAtomic(missing, jsonOptions(missing, {
    createDir: false,
    project: () => ({ changed: true, data: { a: 1 } }),
  }));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /unable to lock sample/);
  assert.equal(fs.existsSync(path.dirname(missing)), false);

  const written = updateJsonAtomic(missing, jsonOptions(missing, {
    project: () => ({ changed: true, data: { a: 1 } }),
  }));
  assert.equal(written.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(missing, 'utf8')), { a: 1 });
});

test('the lock helper reclaims a dead holder and refuses a live one', () => {
  const file = path.join(sandbox, 'locked.json');
  const lock = path.join(sandbox, '.locked.json.prism.lock');
  const project = () => ({ changed: true, data: { ok: true } });

  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 3, token: 'dead' }));
  assert.equal(updateJsonAtomic(file, jsonOptions(file, { project })).ok, true);
  assert.equal(fs.existsSync(lock), false);

  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live' }));
  const blocked = updateJsonAtomic(file, jsonOptions(file, { project }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'sample update is locked');
  fs.rmSync(lock);
});

test('the lock helper retries when the file changed under its snapshot', () => {
  const file = path.join(sandbox, 'cas.json');
  fs.writeFileSync(file, '{"n":1}');
  let first = true;
  const result = updateJsonAtomic(file, jsonOptions(file, {
    project: (value) => {
      if (first) {
        first = false;
        fs.writeFileSync(file, '{"n":2}');
      }
      return { changed: true, data: { n: value.n + 10 } };
    },
  }));
  // The first attempt lost the compare-and-swap; the retry saw n=2.
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 12 });
});
