'use strict';

const RELAY_FLAG = '--relay-output';

// Runs a CLI entrypoint. With --relay-output, stderr text goes to stdout in
// order and the exit code is always 0, so no shell-level `2>&1 || true` is
// needed. Without the flag the entrypoint behaves exactly as before.
async function runCli(run, { argv = process.argv.slice(2), exit = false } = {}) {
  if (!argv.includes(RELAY_FLAG)) {
    const code = await run(argv);
    if (exit) process.exit(code);
    else process.exitCode = code;
    return;
  }

  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk, encoding, callback) => process.stdout.write(chunk, encoding, callback);
  try {
    await run(argv.filter((arg) => arg !== RELAY_FLAG));
  } catch (error) {
    process.stdout.write(`${(error && error.message) || String(error)}\n`);
  } finally {
    process.stderr.write = originalWrite;
  }
  if (exit) process.exit(0);
  else process.exitCode = 0;
}

module.exports = { RELAY_FLAG, runCli };
