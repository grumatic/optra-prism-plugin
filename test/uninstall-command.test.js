const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildOtelHeaders } = require('../lib/plugin-version');
const { OTEL_KEYS, PLUGIN_ID } = require('../lib/settings');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'lib', 'uninstall.js');
const FIXTURE_API_KEY = 'opaque-fixture-key';
const FIXTURE_INGEST_URL = 'https://ingest.example.test';
const INVALID_PLAN_TOKEN = '0'.repeat(64);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeFile(file, contents = 'present\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function snapshotTree(root) {
  const snapshot = {};

  function visit(current) {
    const relative = path.relative(root, current) || '.';
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      snapshot[relative] = `symlink:${fs.readlinkSync(current)}`;
      return;
    }
    if (stat.isDirectory()) {
      snapshot[relative] = 'directory';
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name));
      }
      return;
    }
    snapshot[relative] = fs.readFileSync(current, 'utf8');
  }

  visit(root);
  return snapshot;
}

function fixture({ remaining = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-uninstall-test-'));
  const homeDir = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  const otherProjectDir = path.join(root, 'other-project');
  const dataDir = path.join(
    homeDir,
    '.claude',
    'plugins',
    'data',
    'prism-optra-prism',
  );
  const inlineDataDir = path.join(
    homeDir,
    '.claude',
    'plugins',
    'data',
    'prism-inline',
  );
  const cacheDir = path.join(homeDir, '.claude', 'plugins', 'cache', 'optra-prism');
  const pluginCacheDir = path.join(cacheDir, 'prism');
  const pluginRoot = path.join(pluginCacheDir, '0.7.0');
  const siblingCacheDir = path.join(cacheDir, 'sibling');
  const inlinePluginRoot = path.join(root, 'plugin-checkout');
  const devCacheDir = path.join(
    homeDir,
    '.claude',
    'plugins',
    'cache',
    'optra-prism-dev',
  );
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(otherProjectDir, { recursive: true });

  const prismEnv = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${FIXTURE_INGEST_URL}/v1/logs`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${FIXTURE_INGEST_URL}/v1/metrics`,
    OTEL_EXPORTER_OTLP_HEADERS: buildOtelHeaders(FIXTURE_API_KEY),
    OTEL_LOG_USER_PROMPTS: '1',
    OTEL_LOG_ASSISTANT_RESPONSES: '0',
    OTEL_LOG_TOOL_DETAILS: '1',
  };
  const userSettings = path.join(homeDir, '.claude', 'settings.json');
  const projectSettings = path.join(projectDir, '.claude', 'settings.json');
  const localSettings = path.join(projectDir, '.claude', 'settings.local.json');
  writeJson(userSettings, {
    env: { ...prismEnv, USER_ONLY: 'preserve' },
    enabledPlugins: { [PLUGIN_ID]: true, 'other@example': true },
    extraKnownMarketplaces: {
      'optra-prism': { source: { source: 'github', repo: 'grumatic/optra-prism-plugin' } },
    },
  });
  writeJson(projectSettings, {
    env: { ...prismEnv, PROJECT_ONLY: 'preserve' },
    enabledPlugins: { [PLUGIN_ID]: true, 'other@example': true },
  });
  writeJson(localSettings, {
    env: { ...prismEnv, LOCAL_ONLY: 'preserve' },
    enabledPlugins: { [PLUGIN_ID]: true, 'other@example': true },
  });

  const currentEntry = {
    scope: 'local',
    projectPath: projectDir,
    installPath: pluginRoot,
    version: '0.7.0',
  };
  const remainingEntries = remaining ? [
    {
      scope: 'local',
      projectPath: otherProjectDir,
      installPath: pluginRoot,
      version: '0.7.0',
    },
    {
      scope: 'user',
      installPath: pluginRoot,
      version: '0.7.0',
    },
  ] : [];
  const installedPlugins = path.join(
    homeDir,
    '.claude',
    'plugins',
    'installed_plugins.json',
  );
  writeJson(installedPlugins, {
    plugins: {
      [PLUGIN_ID]: [currentEntry, ...remainingEntries],
      'other@example': [{ scope: 'user' }],
    },
  });

  const knownMarketplaces = path.join(
    homeDir,
    '.claude',
    'plugins',
    'known_marketplaces.json',
  );
  writeJson(knownMarketplaces, {
    'optra-prism': {
      source: { source: 'github', repo: 'grumatic/optra-prism-plugin' },
    },
  });
  writeFile(path.join(homeDir, '.claude', 'plugins', 'marketplaces', 'optra-prism', 'marker'));
  writeJson(path.join(homeDir, '.prism', 'config.json'), {
    apiKey: FIXTURE_API_KEY,
    ingest_url: FIXTURE_INGEST_URL,
  });
  writeFile(path.join(dataDir, 'runtime', 'sessions', 'session.json'), '{}\n');
  writeFile(path.join(inlineDataDir, 'runtime', 'sessions', 'inline-session.json'), '{}\n');
  writeFile(path.join(pluginRoot, 'lib', 'settings.js'));
  writeFile(path.join(siblingCacheDir, 'keep'));
  writeFile(path.join(inlinePluginRoot, 'lib', 'uninstall.js'));
  writeFile(path.join(devCacheDir, 'prism-dev', '0.7.0', 'marker'));

  return {
    root,
    homeDir,
    projectDir,
    otherProjectDir,
    dataDir,
    inlineDataDir,
    cacheDir,
    pluginCacheDir,
    pluginRoot,
    siblingCacheDir,
    inlinePluginRoot,
    devCacheDir,
    userSettings,
    projectSettings,
    localSettings,
    installedPlugins,
    knownMarketplaces,
  };
}

function run(fx, args, env = {}) {
  const cliArgs = [...args];
  if (!cliArgs.includes('--plugin-root')) {
    cliArgs.push('--plugin-root', fx.pluginRoot);
  }
  return spawnSync(process.execPath, [SCRIPT, ...cliArgs], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
      ...env,
    },
  });
}

function extractPlanToken(result) {
  assert.equal(result.status, 0, result.stderr);
  const match = result.stdout.match(/^Plan token: ([0-9a-f]{64})$/m);
  assert.ok(match, `preview must emit one safe plan token:\n${result.stdout}`);
  return match[1];
}

function runConfirmed(fx, args, env = {}) {
  const preview = run(fx, ['preview', ...args], env);
  const token = extractPlanToken(preview);
  return run(fx, ['apply', '--confirm', token, ...args], env);
}

function cleanup(fx) {
  fs.rmSync(fx.root, { recursive: true, force: true });
}

function assertManagedOtelRemoved(file, preservedKey) {
  const settings = readJson(file);
  for (const key of OTEL_KEYS) {
    assert.equal(Object.hasOwn(settings.env, key), false, `${key} must be removed from ${file}`);
  }
  assert.equal(settings.env[preservedKey], 'preserve');
}

function assertScopeUntouched(file, preservedKey) {
  const settings = readJson(file);
  for (const key of OTEL_KEYS) {
    assert.ok(Object.hasOwn(settings.env, key), `${key} must be preserved in ${file}`);
  }
  assert.equal(settings.env[preservedKey], 'preserve');
  assert.equal(settings.enabledPlugins[PLUGIN_ID], true);
  assert.equal(settings.enabledPlugins['other@example'], true);
}

function runWithRegistryWriteFailure(fx) {
  const source = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const events = [];',
    'const writeJsonFn = (file, data) => {',
    "  events.push({ type: 'write', file });",
    '  if (file === plan.targets.installedPlugins) throw new Error("injected registry failure");',
    '  fs.mkdirSync(path.dirname(file), { recursive: true });',
    "  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\\n`);",
    '};',
    'const removePathFn = (target) => {',
    "  events.push({ type: 'remove', target });",
    '  fs.rmSync(target, { recursive: true, force: true });',
    '};',
    'try {',
    '  uninstall.applyPlan(plan, { writeJsonFn, removePathFn });',
    '  process.exitCode = 9;',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ message: error.message, events }));',
    '  if (error.message !== "injected registry failure") process.exitCode = 8;',
    '}',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

function runWithSettingsWriteFailure(fx) {
  const source = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const events = [];',
    'const writeJsonFn = (file, data) => {',
    "  events.push({ type: 'write', file });",
    '  if (file !== plan.targets.installedPlugins) throw new Error("injected settings failure");',
    '  fs.mkdirSync(path.dirname(file), { recursive: true });',
    "  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\\n`);",
    '};',
    'const removePathFn = (target) => {',
    "  events.push({ type: 'remove', target });",
    '  fs.rmSync(target, { recursive: true, force: true });',
    '};',
    'try {',
    '  uninstall.applyPlan(plan, { writeJsonFn, removePathFn });',
    '  process.exitCode = 9;',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ message: error.message, events }));',
    '  process.exitCode = 2;',
    '}',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

function runWithCacheRemovalFailure(fx) {
  const source = [
    "const fs = require('node:fs');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const removePathFn = (target) => {',
    '  if (target === plan.targets.pluginCacheDir) throw new Error("injected cache failure");',
    '  fs.rmSync(target, { recursive: true, force: true });',
    '};',
    'const result = uninstall.applyPlan(plan, { removePathFn });',
    'const rendered = uninstall.renderApplied(plan, result);',
    'const exitCode = uninstall.resultExitCode(result);',
    'process.stdout.write(JSON.stringify({ result, rendered, exitCode }));',
    'process.exitCode = exitCode;',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

function runAfterPlannedInputChange(fx, input) {
  const source = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const input = process.argv[5];',
    'const file = input === "registry" ? plan.targets.installedPlugins : plan.settingsWrites[0].file;',
    "const changed = JSON.parse(fs.readFileSync(file, 'utf8'));",
    'if (input === "registry") changed.concurrentUpdate = { preserve: true };',
    'else changed.env.CONCURRENT_UPDATE = "preserve";',
    "fs.writeFileSync(file, `${JSON.stringify(changed, null, 2)}\\n`);",
    'const events = [];',
    'const writeJsonFn = (target, data) => {',
    "  events.push({ type: 'write', target });",
    '  fs.mkdirSync(path.dirname(target), { recursive: true });',
    "  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\\n`);",
    '};',
    'const removePathFn = (target) => {',
    "  events.push({ type: 'remove', target });",
    '  fs.rmSync(target, { recursive: true, force: true });',
    '};',
    'try {',
    '  uninstall.applyPlan(plan, { writeJsonFn, removePathFn });',
    '  process.exitCode = 9;',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ message: error.message, events }));',
    '  if (!error.message.includes("changed after planning")) process.exitCode = 8;',
    '}',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
    input,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

function runWithFinalRecheckDrift(fx, input) {
  const source = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const input = process.argv[5];',
    'const file = input === "registry" ? plan.targets.installedPlugins : plan.settingsSnapshots[0].file;',
    'const beforeCommitFn = () => {',
    "  const changed = JSON.parse(fs.readFileSync(file, 'utf8'));",
    '  if (input === "registry") changed.finalRace = { preserve: true };',
    '  else changed.env.FINAL_RACE = "preserve";',
    "  fs.writeFileSync(file, `${JSON.stringify(changed, null, 2)}\\n`);",
    '};',
    'const events = [];',
    'const writeJsonFn = (target, data) => {',
    "  events.push({ type: 'write', target });",
    '  fs.mkdirSync(path.dirname(target), { recursive: true });',
    "  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\\n`);",
    '};',
    'const removePathFn = (target) => {',
    "  events.push({ type: 'remove', target });",
    '  fs.rmSync(target, { recursive: true, force: true });',
    '};',
    'try {',
    '  uninstall.applyPlan(plan, { beforeCommitFn, writeJsonFn, removePathFn });',
    '  process.exitCode = 9;',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ message: error.message, events }));',
    '  if (!error.message.includes("changed after planning")) process.exitCode = 8;',
    '}',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
    input,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

function runWithPostCommitRegistryDrift(fx) {
  const source = [
    "const fs = require('node:fs');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const afterRegistryCommitFn = () => {',
    "  const registry = JSON.parse(fs.readFileSync(plan.targets.installedPlugins, 'utf8'));",
    '  registry.plugins["prism@optra-prism"] = [{',
    '    scope: "local",',
    '    projectPath: process.argv[5],',
    '    installPath: process.argv[4],',
    '    version: "0.7.0",',
    '  }];',
    "  fs.writeFileSync(plan.targets.installedPlugins, `${JSON.stringify(registry, null, 2)}\\n`);",
    '};',
    'try {',
    '  uninstall.applyPlan(plan, { afterRegistryCommitFn });',
    '  process.exitCode = 9;',
    '} catch (error) {',
    '  process.stdout.write(JSON.stringify({ message: error.message }));',
    '  process.exitCode = 2;',
    '}',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
    fx.otherProjectDir,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

function runWithPostCommitDataSymlink(fx, externalDir, preservedDataDir) {
  const source = [
    "const fs = require('node:fs');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const afterRegistryCommitFn = () => {',
    '  fs.renameSync(plan.targets.pluginDataDir, process.argv[6]);',
    '  fs.symlinkSync(process.argv[5], plan.targets.pluginDataDir);',
    '};',
    'const result = uninstall.applyPlan(plan, { afterRegistryCommitFn });',
    'const rendered = uninstall.renderApplied(plan, result);',
    'const exitCode = uninstall.resultExitCode(result);',
    'process.stdout.write(JSON.stringify({ result, rendered, exitCode }));',
    'process.exitCode = exitCode;',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
    externalDir,
    preservedDataDir,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

function runWithDataRemovalFailure(fx) {
  const source = [
    "const fs = require('node:fs');",
    'const uninstall = require(process.argv[1]);',
    'const plan = uninstall.buildPlan({ projectDir: process.argv[2], dataDir: process.argv[3], pluginRoot: process.argv[4] });',
    'const removePathFn = (target) => {',
    '  if (target === plan.targets.pluginDataDir) throw new Error("injected data failure");',
    '  fs.rmSync(target, { recursive: true, force: true });',
    '};',
    'const result = uninstall.applyPlan(plan, { removePathFn });',
    'const rendered = uninstall.renderApplied(plan, result);',
    'const exitCode = uninstall.resultExitCode(result);',
    'process.stdout.write(JSON.stringify({ result, rendered, exitCode }));',
    'process.exitCode = exitCode;',
  ].join('\n');

  return spawnSync(process.execPath, [
    '-e',
    source,
    SCRIPT,
    fx.projectDir,
    fx.dataDir,
    fx.pluginRoot,
  ], {
    cwd: fx.projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.homeDir,
      CLAUDE_PROJECT_DIR: fx.projectDir,
      CLAUDE_PLUGIN_DATA: fx.dataDir,
    },
  });
}

test('command preauthorizes only preview and maps one safe plan token to one apply', () => {
  const command = fs.readFileSync(path.join(ROOT, 'commands', 'uninstall.md'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'agents', 'prism-uninstall.md'), 'utf8');
  const frontmatter = command.match(/^---\n([\s\S]*?)\n---\n/)[1];
  const agentFrontmatter = agent.match(/^---\n([\s\S]*?)\n---\n/)[1];

  assert.match(frontmatter, /^disable-model-invocation: true$/m);
  assert.match(frontmatter, /^context: fork$/m);
  assert.match(frontmatter, /^agent: prism:prism-uninstall$/m);
  assert.match(frontmatter, /^allowed-tools:$/m);
  assert.match(
    frontmatter,
    /^  - Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/uninstall\.js" preview --project-dir "\$\{CLAUDE_PROJECT_DIR\}" --data-dir "\$\{CLAUDE_PLUGIN_DATA\}" --plugin-root "\$\{CLAUDE_PLUGIN_ROOT\}"\)$/m,
  );
  assert.doesNotMatch(frontmatter, /uninstall\.js" apply/);
  assert.match(agentFrontmatter, /^model: haiku$/m);
  assert.match(agentFrontmatter, /^tools: \["Bash"\]$/m);
  assert.match(command, /run the selected command exactly once/i);
  assert.match(command, /character-for-character/i);
  const commandBody = command.replace(/^---\n[\s\S]*?\n---\n/, '');
  assert.equal(
    (commandBody.match(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/uninstall\.js"/g) || []).length,
    2,
  );
  assert.doesNotMatch(command, /rm\s+-rf|optra-prism-\*|!\s*`/);
  assert.match(command, /\^confirm \(\[0-9a-f\]\{64\}\)\$/);
  assert.match(agent, /\^confirm \(\[0-9a-f\]\{64\}\)\$/);
  assert.match(agent, /run apply exactly once/i);
  assert.match(command, /Reject every other argument shape without running Bash/i);
  assert.match(command, /Usage: \/prism:uninstall \[confirm <plan-token>\]/);
});

test('default action previews exact cleanup without writing and emits a semantic token', () => {
  const fx = fixture({ remaining: true });
  try {
    const before = snapshotTree(fx.homeDir);
    const result = run(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^Prism uninstall preview/m);
    assert.match(result.stdout, /No files were changed/);
    const token = extractPlanToken(result);
    assert.match(result.stdout, new RegExp(`/prism:uninstall confirm ${token}`));
    assert.match(
      result.stdout,
      new RegExp(fx.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.match(result.stdout, /Preserve shared Prism config/);
    assert.match(result.stdout, /Preserve marketplace plugin data/);
    assert.match(result.stdout, /Preserve the exact Prism plugin cache/);
    assert.match(result.stdout, new RegExp(fx.otherProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.stdout, /\(user scope\)/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('apply requires a lowercase 64-character plan token before any mutation', () => {
  const fx = fixture();
  try {
    const before = snapshotTree(fx.homeDir);
    const result = run(fx, [
      'apply',
      '--confirm',
      'confirm',
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /confirmation rejected/);
    assert.match(result.stderr, /\/prism:uninstall confirm <plan-token>/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('scope drift after preview rejects the old token with zero apply mutation', () => {
  const fx = fixture();
  try {
    const args = [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ];
    const token = extractPlanToken(run(fx, ['preview', ...args]));
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID][0].scope = 'project';
    writeJson(fx.installedPlugins, installed);
    const drifted = snapshotTree(fx.homeDir);

    const result = run(fx, ['apply', '--confirm', token, ...args]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /plan token does not match/);
    assert.deepEqual(snapshotTree(fx.homeDir), drifted);
  } finally {
    cleanup(fx);
  }
});

test('registry drift after preview rejects the old token with zero apply mutation', () => {
  const fx = fixture();
  try {
    const args = [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ];
    const token = extractPlanToken(run(fx, ['preview', ...args]));
    const installed = readJson(fx.installedPlugins);
    installed.concurrentInstall = { preserve: true };
    writeJson(fx.installedPlugins, installed);
    const drifted = snapshotTree(fx.homeDir);

    const result = run(fx, ['apply', '--confirm', token, ...args]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /plan token does not match/);
    assert.deepEqual(snapshotTree(fx.homeDir), drifted);
  } finally {
    cleanup(fx);
  }
});

test('settings drift after preview rejects the old token with zero apply mutation', () => {
  const fx = fixture();
  try {
    const args = [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ];
    const token = extractPlanToken(run(fx, ['preview', ...args]));
    const settings = readJson(fx.localSettings);
    settings.env.CONCURRENT_OVERRIDE = 'preserve';
    writeJson(fx.localSettings, settings);
    const drifted = snapshotTree(fx.homeDir);

    const result = run(fx, ['apply', '--confirm', token, ...args]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /plan token does not match/);
    assert.deepEqual(snapshotTree(fx.homeDir), drifted);
  } finally {
    cleanup(fx);
  }
});

test('plan tokens canonicalize JSON formatting while preserving semantic drift detection', () => {
  const fx = fixture();
  try {
    const args = [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ];
    const first = extractPlanToken(run(fx, ['preview', ...args]));
    fs.writeFileSync(fx.installedPlugins, JSON.stringify(readJson(fx.installedPlugins)));
    fs.writeFileSync(fx.localSettings, JSON.stringify(readJson(fx.localSettings)));
    const second = extractPlanToken(run(fx, ['preview', ...args]));

    assert.equal(second, first);
  } finally {
    cleanup(fx);
  }
});

test('exact confirmation removes the current final install and only exact owned targets', () => {
  const fx = fixture();
  try {
    const knownMarketplacesBefore = fs.readFileSync(fx.knownMarketplaces, 'utf8');
    const result = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assertScopeUntouched(fx.userSettings, 'USER_ONLY');
    assertScopeUntouched(fx.projectSettings, 'PROJECT_ONLY');
    assertManagedOtelRemoved(fx.localSettings, 'LOCAL_ONLY');
    const localSettings = readJson(fx.localSettings);
    assert.equal(Object.hasOwn(localSettings.enabledPlugins, PLUGIN_ID), false);
    assert.equal(localSettings.enabledPlugins['other@example'], true);

    const installed = readJson(fx.installedPlugins);
    assert.equal(Object.hasOwn(installed.plugins, PLUGIN_ID), false);
    assert.deepEqual(installed.plugins['other@example'], [{ scope: 'user' }]);
    assert.equal(fs.existsSync(path.join(fx.homeDir, '.prism')), false);
    assert.equal(fs.existsSync(fx.dataDir), false);
    assert.equal(fs.existsSync(fx.inlineDataDir), true);
    assert.equal(fs.existsSync(fx.pluginCacheDir), false);
    assert.equal(fs.existsSync(path.join(fx.siblingCacheDir, 'keep')), true);
    assert.equal(fs.existsSync(fx.devCacheDir), true);
    assert.equal(fs.readFileSync(fx.knownMarketplaces, 'utf8'), knownMarketplacesBefore);
    assert.equal(
      fs.existsSync(path.join(
        fx.homeDir,
        '.claude',
        'plugins',
        'marketplaces',
        'optra-prism',
        'marker',
      )),
      true,
    );
    assert.match(result.stdout, /marketplace registration \(optra-prism\) was preserved/);
    assert.match(result.stdout, /Restart Claude Code/);
    assert.match(result.stdout, /Your data is still on the dashboard/);
  } finally {
    cleanup(fx);
  }
});

test('diverged OTEL values are preserved with a warning instead of claimed as Prism-owned', () => {
  const fx = fixture();
  try {
    const settings = readJson(fx.localSettings);
    settings.env.OTEL_LOGS_EXPORTER = 'user-selected-console';
    writeJson(fx.localSettings, settings);
    const args = [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ];
    const preview = run(fx, ['preview', ...args]);
    const token = extractPlanToken(preview);

    assert.match(preview.stdout, /Preserve diverged or unverified OTEL values: OTEL_LOGS_EXPORTER/);

    const result = run(fx, ['apply', '--confirm', token, ...args]);

    assert.equal(result.status, 0, result.stderr);
    const cleaned = readJson(fx.localSettings);
    assert.equal(cleaned.env.OTEL_LOGS_EXPORTER, 'user-selected-console');
    for (const key of OTEL_KEYS.filter((entry) => entry !== 'OTEL_LOGS_EXPORTER')) {
      assert.equal(Object.hasOwn(cleaned.env, key), false, key);
    }
    assert.match(result.stdout, /OTEL values were preserved because they do not exactly match/);
    assert.equal(Object.hasOwn(cleaned.enabledPlugins, PLUGIN_ID), false);
  } finally {
    cleanup(fx);
  }
});

test('remaining installs stay registered and keep shared config, data, and cache', () => {
  const fx = fixture({ remaining: true });
  try {
    const sharedBefore = {
      prism: snapshotTree(path.join(fx.homeDir, '.prism')),
      data: snapshotTree(fx.dataDir),
      cache: snapshotTree(fx.cacheDir),
    };
    const result = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const installed = readJson(fx.installedPlugins);
    assert.deepEqual(installed.plugins[PLUGIN_ID].map((entry) => ({
      scope: entry.scope,
      projectPath: entry.projectPath,
    })), [
      { scope: 'local', projectPath: fx.otherProjectDir },
      { scope: 'user', projectPath: undefined },
    ]);
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), sharedBefore.prism);
    assert.deepEqual(snapshotTree(fx.dataDir), sharedBefore.data);
    assert.deepEqual(snapshotTree(fx.cacheDir), sharedBefore.cache);
    assert.equal(readJson(fx.userSettings).enabledPlugins[PLUGIN_ID], true);
    assert.equal(readJson(fx.projectSettings).enabledPlugins[PLUGIN_ID], true);
    assert.equal(
      Object.hasOwn(readJson(fx.localSettings).enabledPlugins, PLUGIN_ID),
      false,
    );
    assertScopeUntouched(fx.userSettings, 'USER_ONLY');
    assertScopeUntouched(fx.projectSettings, 'PROJECT_ONLY');
    assertManagedOtelRemoved(fx.localSettings, 'LOCAL_ONLY');
    assert.match(result.stdout, /Prism remains installed in/);
    assert.match(result.stdout, /OTEL projection preserved for remaining installs: user/);
    assert.match(result.stdout, /\(user scope\)/);
    assert.match(result.stdout, new RegExp(fx.otherProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanup(fx);
  }
});

test('last marketplace install removes marketplace data/cache while an inline install remains', () => {
  const fx = fixture();
  try {
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID].push({
      scope: 'local',
      projectPath: fx.otherProjectDir,
      installPath: fx.inlinePluginRoot,
      version: '0.7.0',
    });
    writeJson(fx.installedPlugins, installed);
    const configBefore = snapshotTree(path.join(fx.homeDir, '.prism'));
    const inlineDataBefore = snapshotTree(fx.inlineDataDir);

    const result = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readJson(fx.installedPlugins).plugins[PLUGIN_ID].length, 1);
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), configBefore);
    assert.equal(fs.existsSync(fx.dataDir), false);
    assert.deepEqual(snapshotTree(fx.inlineDataDir), inlineDataBefore);
    assert.equal(fs.existsSync(fx.pluginCacheDir), false);
    assert.equal(fs.existsSync(path.join(fx.siblingCacheDir, 'keep')), true);
  } finally {
    cleanup(fx);
  }
});

test('last inline install removes inline data while a marketplace install remains', () => {
  const fx = fixture();
  try {
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID] = [
      {
        scope: 'local',
        projectPath: fx.projectDir,
        installPath: fx.inlinePluginRoot,
        version: '0.7.0',
      },
      {
        scope: 'user',
        installPath: fx.pluginRoot,
        version: '0.7.0',
      },
    ];
    writeJson(fx.installedPlugins, installed);
    const configBefore = snapshotTree(path.join(fx.homeDir, '.prism'));
    const marketplaceDataBefore = snapshotTree(fx.dataDir);
    const cacheBefore = snapshotTree(fx.cacheDir);

    const result = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.inlineDataDir,
      '--plugin-root',
      fx.inlinePluginRoot,
    ], {
      CLAUDE_PLUGIN_DATA: fx.inlineDataDir,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readJson(fx.installedPlugins).plugins[PLUGIN_ID].length, 1);
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), configBefore);
    assert.equal(fs.existsSync(fx.inlineDataDir), false);
    assert.deepEqual(snapshotTree(fx.dataDir), marketplaceDataBefore);
    assert.deepEqual(snapshotTree(fx.cacheDir), cacheBefore);
  } finally {
    cleanup(fx);
  }
});

test('an unclassified remaining install conservatively preserves config, data, and cache', () => {
  const fx = fixture();
  try {
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID].push({
      scope: 'local',
      projectPath: fx.otherProjectDir,
      installPath: path.join(fx.root, 'missing-plugin-root'),
      version: '0.7.0',
    });
    writeJson(fx.installedPlugins, installed);
    const sharedBefore = {
      config: snapshotTree(path.join(fx.homeDir, '.prism')),
      data: snapshotTree(fx.dataDir),
      cache: snapshotTree(fx.cacheDir),
    };

    const result = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), sharedBefore.config);
    assert.deepEqual(snapshotTree(fx.dataDir), sharedBefore.data);
    assert.deepEqual(snapshotTree(fx.cacheDir), sharedBefore.cache);
  } finally {
    cleanup(fx);
  }
});

test('local uninstall preserves a project-scope install for the same project', () => {
  const fx = fixture();
  try {
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID].push({
      scope: 'project',
      projectPath: fx.projectDir,
      installPath: path.join(fx.cacheDir, 'prism', '0.7.0'),
      version: '0.7.0',
    });
    writeJson(fx.installedPlugins, installed);
    const sharedBefore = {
      prism: snapshotTree(path.join(fx.homeDir, '.prism')),
      data: snapshotTree(fx.dataDir),
      cache: snapshotTree(fx.cacheDir),
    };

    const result = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readJson(fx.installedPlugins).plugins[PLUGIN_ID].map((entry) => ({
      scope: entry.scope,
      projectPath: entry.projectPath,
    })), [
      { scope: 'project', projectPath: fx.projectDir },
    ]);
    assert.equal(
      Object.hasOwn(readJson(fx.localSettings).enabledPlugins, PLUGIN_ID),
      false,
    );
    assert.equal(readJson(fx.projectSettings).enabledPlugins[PLUGIN_ID], true);
    assertScopeUntouched(fx.userSettings, 'USER_ONLY');
    assertManagedOtelRemoved(fx.localSettings, 'LOCAL_ONLY');
    assertScopeUntouched(fx.projectSettings, 'PROJECT_ONLY');
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), sharedBefore.prism);
    assert.deepEqual(snapshotTree(fx.dataDir), sharedBefore.data);
    assert.deepEqual(snapshotTree(fx.cacheDir), sharedBefore.cache);
    assert.match(result.stdout, /OTEL projection preserved for remaining installs: project/);
    assert.match(result.stdout, new RegExp(fx.projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanup(fx);
  }
});

test('user-scope uninstall preserves another project install and its shared artifacts', () => {
  const fx = fixture({ remaining: true });
  try {
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID] = installed.plugins[PLUGIN_ID].slice(1);
    writeJson(fx.installedPlugins, installed);
    const sharedBefore = {
      prism: snapshotTree(path.join(fx.homeDir, '.prism')),
      data: snapshotTree(fx.dataDir),
      cache: snapshotTree(fx.cacheDir),
    };

    const result = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const remaining = readJson(fx.installedPlugins).plugins[PLUGIN_ID];
    assert.deepEqual(remaining.map((entry) => ({
      scope: entry.scope,
      projectPath: entry.projectPath,
    })), [
      { scope: 'local', projectPath: fx.otherProjectDir },
    ]);
    assert.equal(
      Object.hasOwn(readJson(fx.userSettings).enabledPlugins, PLUGIN_ID),
      false,
    );
    assertManagedOtelRemoved(fx.userSettings, 'USER_ONLY');
    assertScopeUntouched(fx.projectSettings, 'PROJECT_ONLY');
    assertScopeUntouched(fx.localSettings, 'LOCAL_ONLY');
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), sharedBefore.prism);
    assert.deepEqual(snapshotTree(fx.dataDir), sharedBefore.data);
    assert.deepEqual(snapshotTree(fx.cacheDir), sharedBefore.cache);
    assert.match(result.stdout, new RegExp(fx.otherProjectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanup(fx);
  }
});

test('project uninstall preserves shared user settings when the project is home', () => {
  const fx = fixture();
  const homeProject = {
    ...fx,
    projectDir: fx.homeDir,
    projectSettings: fx.userSettings,
  };
  try {
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID] = [
      {
        scope: 'project',
        projectPath: fx.homeDir,
        installPath: fx.pluginRoot,
        version: '0.7.0',
      },
      {
        scope: 'user',
        installPath: fx.pluginRoot,
        version: '0.7.0',
      },
    ];
    writeJson(fx.installedPlugins, installed);
    const settingsBefore = fs.readFileSync(fx.userSettings, 'utf8');
    const sharedBefore = {
      prism: snapshotTree(path.join(fx.homeDir, '.prism')),
      data: snapshotTree(fx.dataDir),
      cache: snapshotTree(fx.cacheDir),
    };
    const preview = run(homeProject, [
      'preview',
      '--project-dir',
      fx.homeDir,
      '--data-dir',
      fx.dataDir,
    ]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(
      preview.stdout,
      /Preserve the shared settings file because a remaining Prism install still uses it/,
    );
    assert.doesNotMatch(preview.stdout, /Remove Prism-managed OTEL values/);
    assert.doesNotMatch(preview.stdout, /Remove the current scope enabledPlugins registration/);

    const token = extractPlanToken(preview);
    const result = run(homeProject, [
      'apply',
      '--confirm',
      token,
      '--project-dir',
      fx.homeDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(fx.userSettings, 'utf8'), settingsBefore);
    assert.deepEqual(readJson(fx.installedPlugins).plugins[PLUGIN_ID].map((entry) => ({
      scope: entry.scope,
      projectPath: entry.projectPath,
    })), [
      { scope: 'user', projectPath: undefined },
    ]);
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), sharedBefore.prism);
    assert.deepEqual(snapshotTree(fx.dataDir), sharedBefore.data);
    assert.deepEqual(snapshotTree(fx.cacheDir), sharedBefore.cache);
    assert.match(result.stdout, /OTEL projection preserved for remaining installs: user/);
    assert.match(result.stdout, /shared settings file was preserved/);
    assert.match(result.stdout, /shared enabledPlugins registration was preserved/);
  } finally {
    cleanup(fx);
  }
});

test('missing exact registry entry blocks apply without any mutation', () => {
  const fx = fixture({ remaining: true });
  try {
    const installed = readJson(fx.installedPlugins);
    installed.plugins[PLUGIN_ID] = installed.plugins[PLUGIN_ID]
      .filter((entry) => entry.scope === 'local' && entry.projectPath === fx.otherProjectDir);
    writeJson(fx.installedPlugins, installed);
    const before = snapshotTree(fx.homeDir);

    const result = run(fx, [
      'apply',
      '--confirm',
      INVALID_PLAN_TOKEN,
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /plan token does not match/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('absent Prism registry key blocks preview and apply without any mutation', () => {
  const fx = fixture();
  try {
    const installed = readJson(fx.installedPlugins);
    delete installed.plugins[PLUGIN_ID];
    writeJson(fx.installedPlugins, installed);
    const before = snapshotTree(fx.homeDir);

    const preview = run(fx, [
      'preview',
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Cleanup is blocked because no exact Prism install entry/);
    assert.doesNotMatch(preview.stdout, /\/prism:uninstall confirm/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);

    const apply = run(fx, [
      'apply',
      '--confirm',
      INVALID_PLAN_TOKEN,
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);
    assert.equal(apply.status, 2);
    assert.match(apply.stderr, /plan token does not match/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('registry change after planning aborts before any cleanup mutation', () => {
  const fx = fixture();
  try {
    const localSettingsBefore = fs.readFileSync(fx.localSettings, 'utf8');
    const failed = runAfterPlannedInputChange(fx, 'registry');

    assert.equal(failed.status, 0, failed.stderr);
    const payload = JSON.parse(failed.stdout);
    assert.match(payload.message, /installed plugin registry changed after planning/);
    assert.deepEqual(payload.events, []);
    const installed = readJson(fx.installedPlugins);
    assert.deepEqual(installed.concurrentUpdate, { preserve: true });
    assert.equal(installed.plugins[PLUGIN_ID].length, 1);
    assert.equal(fs.readFileSync(fx.localSettings, 'utf8'), localSettingsBefore);
    assert.equal(fs.existsSync(path.join(fx.homeDir, '.prism')), true);
    assert.equal(fs.existsSync(fx.dataDir), true);
    assert.equal(fs.existsSync(fx.cacheDir), true);
  } finally {
    cleanup(fx);
  }
});

test('settings change after planning aborts before any cleanup mutation', () => {
  const fx = fixture();
  try {
    const registryBefore = fs.readFileSync(fx.installedPlugins, 'utf8');
    const settingsBefore = readJson(fx.localSettings);
    const failed = runAfterPlannedInputChange(fx, 'settings');

    assert.equal(failed.status, 0, failed.stderr);
    const payload = JSON.parse(failed.stdout);
    assert.match(payload.message, /local settings changed after planning/);
    assert.deepEqual(payload.events, []);
    assert.equal(fs.readFileSync(fx.installedPlugins, 'utf8'), registryBefore);
    const settings = readJson(fx.localSettings);
    assert.equal(settings.env.CONCURRENT_UPDATE, 'preserve');
    for (const key of OTEL_KEYS) {
      assert.equal(settings.env[key], settingsBefore.env[key]);
    }
    assert.equal(settings.enabledPlugins[PLUGIN_ID], true);
    assert.equal(fs.existsSync(path.join(fx.homeDir, '.prism')), true);
    assert.equal(fs.existsSync(fx.dataDir), true);
    assert.equal(fs.existsSync(fx.cacheDir), true);
  } finally {
    cleanup(fx);
  }
});

test('final precommit re-read rejects registry or settings drift with zero mutation', () => {
  for (const input of ['registry', 'settings']) {
    const fx = fixture();
    try {
      const failed = runWithFinalRecheckDrift(fx, input);

      assert.equal(failed.status, 0, failed.stderr);
      const payload = JSON.parse(failed.stdout);
      assert.match(payload.message, /changed after planning/);
      assert.deepEqual(payload.events, []);
      assert.equal(readJson(fx.installedPlugins).plugins[PLUGIN_ID].length, 1);
      assert.equal(readJson(fx.localSettings).enabledPlugins[PLUGIN_ID], true);
      assert.equal(fs.existsSync(path.join(fx.homeDir, '.prism')), true);
      assert.equal(fs.existsSync(fx.dataDir), true);
      assert.equal(fs.existsSync(fx.pluginCacheDir), true);
    } finally {
      cleanup(fx);
    }
  }
});

test('registry commit failure causes zero settings or artifact deletion', () => {
  const fx = fixture();
  try {
    const registryBefore = fs.readFileSync(fx.installedPlugins, 'utf8');
    const failed = runWithRegistryWriteFailure(fx);

    assert.equal(failed.status, 0, failed.stderr);
    const payload = JSON.parse(failed.stdout);
    assert.equal(payload.message, 'injected registry failure');
    assert.deepEqual(payload.events.at(-1), {
      type: 'write',
      file: fx.installedPlugins,
    });
    assert.equal(payload.events.length, 1);
    assert.equal(fs.readFileSync(fx.installedPlugins, 'utf8'), registryBefore);
    assertScopeUntouched(fx.userSettings, 'USER_ONLY');
    assertScopeUntouched(fx.projectSettings, 'PROJECT_ONLY');
    assertScopeUntouched(fx.localSettings, 'LOCAL_ONLY');
    assert.equal(fs.existsSync(path.join(fx.homeDir, '.prism')), true);
    assert.equal(fs.existsSync(fx.dataDir), true);
    assert.equal(fs.existsSync(fx.pluginRoot), true);
    assert.equal(fs.existsSync(fx.cacheDir), true);

    const retry = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(
      Object.hasOwn(readJson(fx.installedPlugins).plugins, PLUGIN_ID),
      false,
    );
    assert.equal(fs.existsSync(fx.pluginCacheDir), false);
    assert.equal(fs.existsSync(path.join(fx.siblingCacheDir, 'keep')), true);
  } finally {
    cleanup(fx);
  }
});

test('settings write failure rolls registry back, preserves artifacts, and leaves a successful retry', () => {
  const fx = fixture();
  try {
    const registryBefore = readJson(fx.installedPlugins);
    const settingsBefore = fs.readFileSync(fx.localSettings, 'utf8');
    const configBefore = snapshotTree(path.join(fx.homeDir, '.prism'));
    const dataBefore = snapshotTree(fx.dataDir);
    const cacheBefore = snapshotTree(fx.cacheDir);
    const failed = runWithSettingsWriteFailure(fx);

    assert.equal(failed.status, 2, failed.stderr);
    const payload = JSON.parse(failed.stdout);
    assert.match(payload.message, /original installed plugin registry was restored/);
    assert.equal(payload.events.filter((event) => event.type === 'write').length, 3);
    assert.deepEqual(payload.events.filter((event) => event.type === 'remove'), []);
    assert.deepEqual(readJson(fx.installedPlugins), registryBefore);
    assert.equal(fs.readFileSync(fx.localSettings, 'utf8'), settingsBefore);
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), configBefore);
    assert.deepEqual(snapshotTree(fx.dataDir), dataBefore);
    assert.deepEqual(snapshotTree(fx.cacheDir), cacheBefore);

    const retry = runConfirmed(fx, [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(Object.hasOwn(readJson(fx.installedPlugins).plugins, PLUGIN_ID), false);
    assert.equal(fs.existsSync(fx.pluginCacheDir), false);
  } finally {
    cleanup(fx);
  }
});

test('cache cleanup failure reports the exact leftover and exits nonzero', () => {
  const fx = fixture();
  try {
    const result = runWithCacheRemovalFailure(fx);

    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exitCode, 2);
    assert.deepEqual(payload.result.removedShared, ['Prism config', 'Prism plugin data']);
    assert.deepEqual(payload.result.warnings, []);
    assert.deepEqual(payload.result.leftovers, [
      {
        label: 'Prism plugin cache',
        path: fx.pluginCacheDir,
        error: 'injected cache failure',
      },
    ]);
    assert.match(payload.rendered, /Artifact cleanup is incomplete\./);
    assert.match(payload.rendered, new RegExp(fx.pluginCacheDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(payload.rendered, /Manual cleanup required:/);
    assert.equal(
      Object.hasOwn(readJson(fx.installedPlugins).plugins, PLUGIN_ID),
      false,
    );
    assert.equal(fs.existsSync(path.join(fx.homeDir, '.prism')), false);
    assert.equal(fs.existsSync(fx.dataDir), false);
    assert.equal(fs.existsSync(fx.pluginRoot), true);
  } finally {
    cleanup(fx);
  }
});

test('post-commit data cleanup failure reports the exact leftover and exits nonzero', () => {
  const fx = fixture();
  try {
    const result = runWithDataRemovalFailure(fx);

    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exitCode, 2);
    assert.deepEqual(payload.result.warnings, []);
    assert.deepEqual(payload.result.leftovers, [
      {
        label: 'Prism plugin data',
        path: fx.dataDir,
        error: 'injected data failure',
      },
    ]);
    assert.match(payload.rendered, new RegExp(fx.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(payload.rendered, /Manual cleanup required:/);
    assert.equal(
      Object.hasOwn(readJson(fx.installedPlugins).plugins, PLUGIN_ID),
      false,
    );
    assert.equal(fs.existsSync(fx.dataDir), true);
    assert.equal(fs.existsSync(fx.pluginCacheDir), false);
    assert.equal(fs.existsSync(path.join(fx.siblingCacheDir, 'keep')), true);
  } finally {
    cleanup(fx);
  }
});

test('a new install after registry commit makes settings cleanup fatal with no artifact cleanup', () => {
  const fx = fixture();
  try {
    const settingsBefore = fs.readFileSync(fx.localSettings, 'utf8');
    const configBefore = snapshotTree(path.join(fx.homeDir, '.prism'));
    const dataBefore = snapshotTree(fx.dataDir);
    const cacheBefore = snapshotTree(fx.cacheDir);
    const result = runWithPostCommitRegistryDrift(fx);

    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.message, /automatic registry rollback was unsafe or failed/);
    assert.match(payload.message, /Manual cleanup is required/);
    const installed = readJson(fx.installedPlugins).plugins[PLUGIN_ID];
    assert.equal(installed.length, 1);
    assert.equal(installed[0].projectPath, fx.otherProjectDir);
    assert.equal(fs.readFileSync(fx.localSettings, 'utf8'), settingsBefore);
    assert.deepEqual(snapshotTree(path.join(fx.homeDir, '.prism')), configBefore);
    assert.deepEqual(snapshotTree(fx.dataDir), dataBefore);
    assert.deepEqual(snapshotTree(fx.cacheDir), cacheBefore);
  } finally {
    cleanup(fx);
  }
});

test('a post-commit data symlink is reported as an exact leftover without touching its target', () => {
  const fx = fixture();
  try {
    const externalDir = path.join(fx.root, 'external-after-commit');
    const preservedDataDir = path.join(fx.root, 'original-plugin-data');
    writeFile(path.join(externalDir, 'keep'));
    const result = runWithPostCommitDataSymlink(fx, externalDir, preservedDataDir);

    assert.equal(result.status, 2, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.exitCode, 2);
    assert.equal(payload.result.leftovers.length, 1);
    assert.deepEqual(
      {
        label: payload.result.leftovers[0].label,
        path: payload.result.leftovers[0].path,
      },
      {
        label: 'Prism plugin data',
        path: fx.dataDir,
      },
    );
    assert.match(payload.result.leftovers[0].error, /symbolic link/);
    assert.match(payload.rendered, /Manual cleanup required:/);
    assert.equal(
      Object.hasOwn(readJson(fx.installedPlugins).plugins, PLUGIN_ID),
      false,
    );
    assert.equal(fs.lstatSync(fx.dataDir).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(externalDir, 'keep'), 'utf8'), 'present\n');
    assert.equal(fs.existsSync(path.join(preservedDataDir, 'runtime', 'sessions', 'session.json')), true);
  } finally {
    cleanup(fx);
  }
});

test('explicit data target overrides a hostile ambient plugin data value', () => {
  const fx = fixture();
  try {
    const before = snapshotTree(fx.homeDir);
    const result = run(
      fx,
      [
        'preview',
        '--project-dir',
        fx.projectDir,
        '--data-dir',
        fx.dataDir,
      ],
      { CLAUDE_PLUGIN_DATA: fx.homeDir },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Prism uninstall preview/m);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('marketplace root rejects prism-inline data during preview without writes', () => {
  const fx = fixture();
  try {
    const before = snapshotTree(fx.homeDir);
    const result = run(
      fx,
      [
        'preview',
        '--project-dir',
        fx.projectDir,
        '--data-dir',
        fx.inlineDataDir,
      ],
      { CLAUDE_PLUGIN_DATA: fx.inlineDataDir },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not match the marketplace plugin root/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('inline checkout root mismatch blocks preview and apply without mutation', () => {
  const fx = fixture();
  try {
    const before = snapshotTree(fx.homeDir);
    const commonArgs = [
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.inlineDataDir,
      '--plugin-root',
      fx.inlinePluginRoot,
    ];

    const preview = run(fx, ['preview', ...commonArgs]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Cleanup is blocked because no exact Prism install entry/);
    assert.doesNotMatch(preview.stdout, /\/prism:uninstall confirm/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);

    const apply = run(fx, ['apply', '--confirm', INVALID_PLAN_TOKEN, ...commonArgs]);
    assert.equal(apply.status, 2);
    assert.match(apply.stderr, /plan token does not match/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('marketplace root cannot authorize deletion of prism-inline data', () => {
  const fx = fixture();
  try {
    const knownMarketplacesBefore = fs.readFileSync(fx.knownMarketplaces, 'utf8');
    const result = run(
      fx,
      [
        'apply',
        '--confirm',
        INVALID_PLAN_TOKEN,
        '--project-dir',
        fx.projectDir,
        '--data-dir',
        fx.inlineDataDir,
      ],
      { CLAUDE_PLUGIN_DATA: fx.inlineDataDir },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not match the marketplace plugin root/);
    assert.equal(fs.existsSync(fx.inlineDataDir), true);
    assert.equal(fs.existsSync(fx.dataDir), true);
    assert.equal(fs.existsSync(fx.cacheDir), true);
    assert.equal(fs.existsSync(fx.devCacheDir), true);
    assert.equal(fs.readFileSync(fx.knownMarketplaces, 'utf8'), knownMarketplacesBefore);
  } finally {
    cleanup(fx);
  }
});

test('hostile other-plugin data target is rejected before any cleanup', () => {
  const fx = fixture();
  try {
    const otherPluginData = path.join(
      fx.homeDir,
      '.claude',
      'plugins',
      'data',
      'other-plugin',
    );
    writeFile(path.join(otherPluginData, 'keep'));
    const before = snapshotTree(fx.homeDir);
    const result = run(
      fx,
      [
        'apply',
        '--confirm',
        INVALID_PLAN_TOKEN,
        '--project-dir',
        fx.projectDir,
        '--data-dir',
        otherPluginData,
      ],
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not match the marketplace plugin root/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
  } finally {
    cleanup(fx);
  }
});

test('symlinked destructive target is rejected before registry or settings writes', () => {
  const fx = fixture();
  try {
    const externalDir = path.join(fx.root, 'external-data');
    writeFile(path.join(externalDir, 'keep'));
    fs.rmSync(fx.dataDir, { recursive: true, force: true });
    fs.symlinkSync(externalDir, fx.dataDir);
    const before = snapshotTree(fx.homeDir);
    const result = run(fx, [
      'apply',
      '--confirm',
      INVALID_PLAN_TOKEN,
      '--project-dir',
      fx.projectDir,
      '--data-dir',
      fx.dataDir,
    ]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /symbolic link/);
    assert.deepEqual(snapshotTree(fx.homeDir), before);
    assert.equal(fs.readFileSync(path.join(externalDir, 'keep'), 'utf8'), 'present\n');
  } finally {
    cleanup(fx);
  }
});
