'use strict';

// Suites isolate the home directory through HOME, but on Windows os.homedir()
// reads USERPROFILE. This module makes HOME the home-directory source there,
// for the test process and (preloaded through NODE_OPTIONS) its Node children.
// It does nothing on other platforms.

const os = require('os');

function install() {
  if (process.platform !== 'win32' || os.homedir.prismWindowsHome) return;

  if (process.env.HOME) process.env.USERPROFILE = process.env.HOME;

  const original = os.homedir;
  os.homedir = () => process.env.HOME || original();
  os.homedir.prismWindowsHome = true;

  const preload = `--require "${__filename.replace(/\\/g, '/')}"`;
  const current = process.env.NODE_OPTIONS || '';
  if (!current.includes(preload)) {
    process.env.NODE_OPTIONS = current ? `${current} ${preload}` : preload;
  }
}

install();

module.exports = { install };
