'use strict';

// Windows adjustments for the test process. Does nothing on other platforms.
//
// - Suites isolate the home directory through HOME, but os.homedir() reads
//   USERPROFILE on Windows. HOME becomes the home-directory source for this
//   process, and every child process gets USERPROFILE set from its HOME.
// - os.tmpdir() can be an 8.3 short path (RUNNER~1) that never equals the
//   real paths the plugin reports, so TEMP/TMP point at the real path.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');

const SPAWNERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];

function withUserProfile(env) {
  const source = env || process.env;
  if (!source.HOME) return env;
  return { ...source, USERPROFILE: source.HOME };
}

function isOptions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function patchSpawner(name) {
  const original = childProcess[name];
  const patched = function patchedSpawner(...args) {
    let index = args.findIndex((arg, position) => position > 0 && isOptions(arg));
    if (index === -1) {
      index = typeof args[args.length - 1] === 'function' ? args.length - 1 : args.length;
      args.splice(index, 0, {});
    }
    args[index] = { ...args[index], env: withUserProfile(args[index].env) };
    return original.apply(this, args);
  };
  Object.defineProperties(patched, Object.getOwnPropertyDescriptors(original));
  childProcess[name] = patched;
}

function install() {
  if (process.platform !== 'win32' || os.homedir.prismWindowsHome) return;

  const originalHomedir = os.homedir;
  os.homedir = () => process.env.HOME || originalHomedir();
  os.homedir.prismWindowsHome = true;

  for (const name of SPAWNERS) patchSpawner(name);

  try {
    const realTemp = fs.realpathSync.native(os.tmpdir());
    process.env.TEMP = realTemp;
    process.env.TMP = realTemp;
  } catch {}
}

install();

module.exports = { install };
