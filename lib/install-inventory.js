/**
 * Inventory of the Claude config roots where Prism has been seen, plus the
 * read-only verification of those roots.
 *
 * ~/.prism (API key, config, binding) is shared by every config root, so a
 * command that wants to remove it first has to know whether another root still
 * has Prism installed. The inventory lists the roots to look at; verification
 * only reads files and never changes anything inside another root.
 *
 * The inventory file is untrusted input. Anything that prevents a complete
 * verification (a corrupt file, overflow, an unreadable root) keeps ~/.prism.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalizeWithExistingAncestor } = require('./claude-paths');
const { updateJsonAtomic } = require('./locked-json');

const INVENTORY_FILENAME = 'installs.json';
const INVENTORY_VERSION = 1;
const INVENTORY_MODE = 0o600;
const MAX_ROOTS = 32;
const REGISTER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_TIMESTAMP = new Date(0).toISOString();
const PLUGIN_ID = 'prism@optra-prism';

function prismDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.prism');
}

function inventoryPath(homeDir = os.homedir()) {
  return path.join(prismDir(homeDir), INVENTORY_FILENAME);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

// Canonical form of a root; a root that cannot be canonicalized (for example an
// unreadable ancestor) keeps its lexical form so it is still verified.
function canonicalRoot(root) {
  try {
    return canonicalizeWithExistingAncestor(root);
  } catch {
    return path.resolve(root);
  }
}

function emptyInventory() {
  return { status: 'ok', reason: null, roots: new Map(), overflow: false };
}

function mergeEntry(roots, key, entry) {
  const existing = roots.get(key);
  if (!existing) {
    roots.set(key, entry);
    return;
  }
  roots.set(key, {
    firstSeen: Date.parse(existing.firstSeen) <= Date.parse(entry.firstSeen)
      ? existing.firstSeen
      : entry.firstSeen,
    lastSeen: Date.parse(existing.lastSeen) >= Date.parse(entry.lastSeen)
      ? existing.lastSeen
      : entry.lastSeen,
  });
}

function parseInventory(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ...emptyInventory(), status: 'corrupt', reason: `unparsable: ${error.message}` };
  }
  if (!isPlainObject(parsed)
    || parsed.version !== INVENTORY_VERSION
    || !isPlainObject(parsed.roots)
    || (Object.hasOwn(parsed, 'overflow') && typeof parsed.overflow !== 'boolean')) {
    return { ...emptyInventory(), status: 'corrupt', reason: 'unsupported schema' };
  }

  const roots = new Map();
  for (const [key, value] of Object.entries(parsed.roots)) {
    if (key.includes('\0') || !path.isAbsolute(key)) continue;
    const entry = isPlainObject(value) ? value : {};
    const lastSeen = validTimestamp(entry.lastSeen) || UNKNOWN_TIMESTAMP;
    mergeEntry(roots, canonicalRoot(key), {
      firstSeen: validTimestamp(entry.firstSeen) || lastSeen,
      lastSeen,
    });
  }
  return { status: 'ok', reason: null, roots, overflow: parsed.overflow === true };
}

/**
 * A missing file (or missing ~/.prism) is an empty inventory. Anything else
 * that cannot be read as a valid inventory is `corrupt`.
 */
function readInventorySnapshot(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return {
        inventory: emptyInventory(),
        signature: { exists: false, mode: INVENTORY_MODE, digest: null },
      };
    }
    return {
      inventory: { ...emptyInventory(), status: 'corrupt', reason: error.message },
      signature: null,
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      inventory: {
        ...emptyInventory(),
        status: 'corrupt',
        reason: 'inventory is not a regular file',
      },
      signature: null,
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      inventory: { ...emptyInventory(), status: 'corrupt', reason: error.message },
      signature: null,
    };
  }
  return {
    inventory: parseInventory(raw),
    signature: {
      exists: true,
      mode: stat.mode & 0o777,
      digest: crypto.createHash('sha256').update(raw).digest('hex'),
    },
  };
}

function readInventory({ homeDir = os.homedir() } = {}) {
  return readInventorySnapshot(inventoryPath(homeDir)).inventory;
}

function serializeInventory(inventory) {
  const roots = {};
  for (const key of [...inventory.roots.keys()].sort()) {
    const { firstSeen, lastSeen } = inventory.roots.get(key);
    roots[key] = { firstSeen, lastSeen };
  }
  return { version: INVENTORY_VERSION, overflow: inventory.overflow === true, roots };
}

function updateInventoryFile(homeDir, project) {
  const file = inventoryPath(homeDir);
  return updateJsonAtomic(file, {
    noun: 'install inventory',
    // Never create ~/.prism: only setup does that.
    createDir: false,
    // Every successful write leaves the file at 0600, whatever mode it had.
    writeMode: INVENTORY_MODE,
    readSnapshot: (target) => {
      const snapshot = readInventorySnapshot(target);
      if (snapshot.inventory.status === 'corrupt') {
        // Never rewritten: the user decides what to do with a corrupt file.
        throw new Error(`inventory is corrupt (${snapshot.inventory.reason})`);
      }
      return { value: snapshot.inventory, signature: snapshot.signature };
    },
    signaturesMatch: (left, right) => left.exists === right.exists
      && left.mode === right.mode
      && left.digest === right.digest,
    project: (inventory) => {
      const roots = new Map(inventory.roots);
      const next = { ...inventory, roots };
      const proposal = project(next);
      return { ...proposal, data: serializeInventory(next) };
    },
  });
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Records `configRoot` as a place where Prism has been seen. Writes only when
 * ~/.prism already exists and the root is missing or its lastSeen is older than
 * 24 hours. A full inventory sets `overflow` instead of evicting; a corrupt one
 * is left alone.
 */
function registerRoot({
  configRoot,
  homeDir = os.homedir(),
  now = Date.now(),
} = {}) {
  if (!isDirectory(prismDir(homeDir))) return { registered: false, reason: 'no-prism-dir' };
  const key = canonicalRoot(configRoot);
  const inventory = readInventory({ homeDir });
  if (inventory.status === 'corrupt') return { registered: false, reason: 'corrupt' };

  const known = inventory.roots.get(key);
  if (known && now - Date.parse(known.lastSeen) < REGISTER_INTERVAL_MS) {
    return { registered: false, reason: 'fresh' };
  }
  if (!known && inventory.roots.size >= MAX_ROOTS && inventory.overflow) {
    return { registered: false, reason: 'overflow' };
  }

  const nowIso = new Date(now).toISOString();
  const result = updateInventoryFile(homeDir, (next) => {
    const current = next.roots.get(key);
    if (current) {
      next.roots.set(key, { firstSeen: current.firstSeen, lastSeen: nowIso });
      return { changed: true };
    }
    if (next.roots.size >= MAX_ROOTS) {
      const changed = next.overflow !== true;
      next.overflow = true;
      return { changed, overflowed: true };
    }
    next.roots.set(key, { firstSeen: nowIso, lastSeen: nowIso });
    return { changed: true };
  });
  if (!result.ok) return { registered: false, reason: result.reason };
  return {
    registered: result.changed === true && result.overflowed !== true,
    reason: result.overflowed ? 'overflow' : null,
  };
}

/**
 * Removes inventory entries, never touching anything inside those roots.
 * `rootsToRemove` are canonical root paths. An entry is removed only if the
 * root still verifies as absent at the moment of the locked update.
 */
function removeRoots({ rootsToRemove, homeDir = os.homedir() } = {}) {
  const targets = new Set((rootsToRemove || []).map(canonicalRoot));
  if (targets.size === 0) return { ok: true, removed: [] };
  if (!isDirectory(prismDir(homeDir))) return { ok: true, removed: [] };
  const inventory = readInventory({ homeDir });
  if (inventory.status === 'corrupt') return { ok: false, removed: [], reason: 'corrupt' };
  if (![...targets].some((key) => inventory.roots.has(key))) return { ok: true, removed: [] };

  const removed = [];
  const result = updateInventoryFile(homeDir, (next) => {
    for (const key of targets) {
      if (!next.roots.has(key)) continue;
      // The caller verified earlier; verify again under the lock so a root
      // that gained a Prism install since then is never dropped.
      if (verifyRoot(key).state !== 'absent') continue;
      next.roots.delete(key);
      removed.push(key);
    }
    return { changed: removed.length > 0 };
  });
  return result.ok
    ? { ok: true, removed }
    : { ok: false, removed: [], reason: result.reason };
}

// ─── Read-only verification of other roots (D4) ───

function stateOf(root, state, detail) {
  return { root, state, detail };
}

function verifyRoot(root) {
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return stateOf(root, 'absent', 'the config root does not exist');
    }
    return stateOf(root, 'unverifiable', `the config root cannot be inspected: ${error.message}`);
  }
  if (!rootStat.isDirectory()) {
    return stateOf(root, 'unverifiable', 'the config root is not a directory');
  }

  const registry = path.join(root, 'plugins', 'installed_plugins.json');
  let registryStat;
  try {
    registryStat = fs.lstatSync(registry);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return stateOf(root, 'absent', 'no installed plugin registry');
    }
    return stateOf(root, 'unverifiable', `the registry cannot be inspected: ${error.message}`);
  }
  if (registryStat.isSymbolicLink() || !registryStat.isFile()) {
    return stateOf(root, 'unverifiable', 'the registry is not a regular, non-symlink file');
  }

  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(registry, 'utf8'));
  } catch (error) {
    return stateOf(root, 'unverifiable', `the registry cannot be read: ${error.message}`);
  }
  if (!isPlainObject(installed)) {
    return stateOf(root, 'unverifiable', 'the registry is not a JSON object');
  }
  if (!Object.hasOwn(installed, 'plugins')) {
    return stateOf(root, 'absent', 'the registry has no Prism entry');
  }
  if (!isPlainObject(installed.plugins)) {
    return stateOf(root, 'unverifiable', 'the registry "plugins" value is not an object');
  }
  if (!Object.hasOwn(installed.plugins, PLUGIN_ID)) {
    return stateOf(root, 'absent', 'the registry has no Prism entry');
  }
  const entries = installed.plugins[PLUGIN_ID];
  if (!Array.isArray(entries)) {
    return stateOf(root, 'unverifiable', 'the Prism registry value is not an array');
  }
  if (entries.length === 0) return stateOf(root, 'absent', 'the registry has no Prism entry');
  const usable = entries.some((entry) => isPlainObject(entry)
    && typeof entry.installPath === 'string'
    && !entry.installPath.includes('\0')
    && path.isAbsolute(entry.installPath));
  return usable
    ? stateOf(root, 'installed', `${entries.length} Prism registry entr${entries.length === 1 ? 'y' : 'ies'}`)
    : stateOf(root, 'unverifiable', 'a Prism registry entry has a missing or non-absolute installPath');
}

/**
 * Verifies every config root other than `configRoot`: the inventory roots plus
 * the default $HOME/.claude. `installed` and `unverifiable` roots, a corrupt
 * inventory, and an overflowed inventory all keep ~/.prism.
 */
function verifyOtherRoots({ configRoot, homeDir = os.homedir(), inventory } = {}) {
  const current = canonicalRoot(configRoot);
  const known = inventory || readInventory({ homeDir });
  const candidates = new Set(known.roots.keys());
  candidates.add(canonicalRoot(path.join(homeDir, '.claude')));
  candidates.delete(current);

  const roots = [...candidates].sort().map((root) => verifyRoot(root));
  const condition = known.status === 'corrupt'
    ? 'corrupt'
    : (known.overflow ? 'overflow' : 'ok');
  const blocking = roots.filter((entry) => entry.state !== 'absent').map((entry) => entry.root);
  return {
    current,
    roots,
    blocking,
    absent: roots.filter((entry) => entry.state === 'absent').map((entry) => entry.root),
    inventory: {
      condition,
      reason: known.reason,
      knownRoots: known.roots.size,
    },
    // Deletion authority for ~/.prism: only the roots that keep it and the
    // inventory condition. `absent` roots and timestamps are left out so
    // another profile's activity between preview and apply does not drift it.
    authority: {
      blockingRoots: blocking,
      inventory: condition,
    },
    keepsPrismDir: blocking.length > 0 || condition !== 'ok',
  };
}

module.exports = {
  INVENTORY_FILENAME,
  MAX_ROOTS,
  REGISTER_INTERVAL_MS,
  inventoryPath,
  prismDir,
  readInventory,
  registerRoot,
  removeRoots,
  verifyOtherRoots,
  verifyRoot,
};
