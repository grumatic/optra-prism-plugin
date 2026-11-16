'use strict';

// TEMPORARY: summarizes the MEASURE_GIT_LOG lines lib/git.js wrote during a
// suite run: `<name>\t<elapsed ms>\t<outcome>`.

const fs = require('fs');

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.log(`no measurement log at ${file}`);
  process.exit(0);
}

const groups = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const [name, elapsed, outcome] = line.split('\t');
  if (!name || !/^\d+$/.test(elapsed || '')) continue;
  if (!groups.has(name)) groups.set(name, { values: [], outcomes: {} });
  const group = groups.get(name);
  group.values.push(Number(elapsed));
  group.outcomes[outcome] = (group.outcomes[outcome] || 0) + 1;
}

for (const [name, group] of groups) {
  const sorted = group.values.sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const over = (limit) => sorted.filter((value) => value > limit).length;
  console.log(`${name}: n=${sorted.length} p50=${pick(0.5)} p90=${pick(0.9)} p99=${pick(0.99)} max=${sorted[sorted.length - 1]}`
    + ` over250=${over(250)} over1000=${over(1000)} outcomes=${JSON.stringify(group.outcomes)}`);
}
