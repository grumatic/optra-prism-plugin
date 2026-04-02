/**
 * Read all stdin as parsed JSON.
 * Used by hook scripts that receive input from Claude Code.
 *
 * @returns {Promise<object>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    const timeout = setTimeout(() => reject(new Error('stdin timeout')), 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(input));
      } catch (err) {
        reject(err);
      }
    });
  });
}

module.exports = { readStdin };
