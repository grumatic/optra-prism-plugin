'use strict';

// Windows adjustments for the test process and, preloaded through
// NODE_OPTIONS, every Node process it starts. Does nothing on other platforms.
//
// - Suites isolate the home directory through HOME, but os.homedir() reads
//   USERPROFILE on Windows. HOME becomes the home-directory source, and every
//   child process gets USERPROFILE set from its HOME.
// - os.tmpdir() can be an 8.3 short path (RUNNER~1) that never equals the
//   real paths the plugin reports, so TEMP/TMP point at the real path.
// - Fixtures such as the fake Claude host are `#!/bin/sh` scripts that only
//   echo one line. Windows cannot execute them, so execFileSync answers for
//   such a file with the line it would print.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SPAWNERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
const PRELOAD = `--require "${__filename.replace(/\\/g, '/')}"`;
const ECHO_SCRIPT = /^#!\/bin\/sh\necho "([^"\n]*)"\n$/;

function childEnv(env) {
  const next = { ...(env || process.env) };
  if (next.HOME) next.USERPROFILE = next.HOME;
  const nodeOptions = next.NODE_OPTIONS || '';
  if (!nodeOptions.includes(PRELOAD)) {
    next.NODE_OPTIONS = nodeOptions ? `${nodeOptions} ${PRELOAD}` : PRELOAD;
  }
  return next;
}

function isOptions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function echoScriptOutput(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file) !== '') return null;
  try {
    const match = ECHO_SCRIPT.exec(fs.readFileSync(file, 'utf8'));
    return match ? `${match[1]}\n` : null;
  } catch {
    return null;
  }
}

function patchSpawner(name) {
  const original = childProcess[name];
  const patched = function patchedSpawner(...args) {
    let index = args.findIndex((arg, position) => position > 0 && isOptions(arg));
    if (index === -1) {
      index = typeof args[args.length - 1] === 'function' ? args.length - 1 : args.length;
      args.splice(index, 0, {});
    }
    if (name === 'execFileSync') {
      const output = echoScriptOutput(args[0]);
      if (output !== null) {
        const { encoding } = args[index];
        return encoding && encoding !== 'buffer' ? output : Buffer.from(output);
      }
    }
    args[index] = { ...args[index], env: childEnv(args[index].env) };
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
