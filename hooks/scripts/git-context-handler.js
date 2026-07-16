#!/usr/bin/env node
'use strict';

const path = require('path');
const { collectGitContext } = require('../../lib/git');
const { writeGit } = require('../../lib/session');

function readHookStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(input)); } catch { resolve({}); }
    });
  });
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

async function main() {
  const data = await readHookStdin();
  if (
    data.hook_event_name !== 'CwdChanged'
    || !validSessionId(data.session_id)
    || typeof data.new_cwd !== 'string'
    || data.new_cwd.length === 0
    || !path.isAbsolute(data.new_cwd)
  ) return;

  const context = await collectGitContext(data.new_cwd);
  writeGit(data.session_id, context);
}

main().catch(() => {});
