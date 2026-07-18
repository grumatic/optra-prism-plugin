const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');

const outbox = require('../lib/response-outbox');

const dirs = [];
let previousDataDir;

beforeEach(() => {
  previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-response-outbox-'));
  dirs.push(dir);
  process.env.CLAUDE_PLUGIN_DATA = dir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function responseEntry(id, dependsOn) {
  return {
    id,
    kind: 'response',
    ...(dependsOn ? { dependsOn } : {}),
    payload: { response_text: id },
  };
}
function promptEntry(id) {
  return {
    id,
    kind: 'prompt',
    payload: { prompt_text: id },
  };
}
function entryFile(id) {
  return path.join(
    outbox.getOutboxDir(),
    `${crypto.createHash('sha256').update(id).digest('hex')}.json`,
  );
}

test('failed delivery remains queued and is redelivered by the next drain', async () => {
  assert.equal(outbox.enqueue(responseEntry('response-retry')), true);
  const first = await outbox.drain(async () => ({ status: 503, body: 'unavailable' }));
  assert.deepEqual(first.map(({ id, acked }) => ({ id, acked })), [{ id: 'response-retry', acked: false }]);
  assert.equal(outbox.listPending().length, 1);

  let sends = 0;
  const second = await outbox.drain(async () => {
    sends += 1;
    return { status: 202, body: 'accepted' };
  });
  assert.equal(sends, 1);
  assert.deepEqual(second.map(({ id, acked }) => ({ id, acked })), [{ id: 'response-retry', acked: true }]);
  assert.deepEqual(outbox.listPending(), []);
});

test('duplicate idempotent delivery is acknowledged without duplicate local state', async () => {
  const intent = responseEntry('response-idempotent');
  const deliveries = [];
  assert.equal(outbox.enqueue(intent), true);
  await outbox.drain(async (entry) => {
    deliveries.push({ id: entry.id, body: 'created' });
    return { status: 202, body: 'created' };
  });

  assert.equal(outbox.enqueue(intent), true);
  const replay = await outbox.drain(async (entry) => {
    deliveries.push({ id: entry.id, body: 'idempotent-noop' });
    return { status: 202, body: 'idempotent-noop' };
  });
  assert.deepEqual(deliveries, [
    { id: 'response-idempotent', body: 'created' },
    { id: 'response-idempotent', body: 'idempotent-noop' },
  ]);
  assert.equal(replay[0].acked, true);
  assert.deepEqual(outbox.listPending(), []);
});

test('drain sends a pending prompt before its dependent response', async () => {
  assert.equal(outbox.enqueue(responseEntry('response-after-prompt', 'prompt-before-response')), true);
  assert.equal(outbox.enqueue({
    id: 'prompt-before-response',
    kind: 'prompt',
    payload: { prompt_text: 'prompt' },
  }), true);

  const order = [];
  await outbox.drain(async (entry) => {
    order.push(entry.id);
    return { status: 200, body: 'ok' };
  });
  assert.deepEqual(order, ['prompt-before-response', 'response-after-prompt']);
  assert.deepEqual(outbox.listPending(), []);
});

test('corrupt entry files are skipped without preventing a drain', async () => {
  fs.mkdirSync(outbox.getOutboxDir(), { recursive: true });
  fs.writeFileSync(path.join(outbox.getOutboxDir(), `${'a'.repeat(64)}.json`), '{partial');
  assert.deepEqual(outbox.listPending(), []);
  const result = await outbox.drain(async () => {
    throw new Error('sender should not run');
  });
  assert.deepEqual(result, []);
});

test('cap retains a consumed-turn response while evicting older prompt intents', () => {
  assert.equal(outbox.enqueue({
    ...responseEntry('response-consumed'),
    createdAt: new Date(0).toISOString(),
  }), true);
  for (let index = 0; index < outbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(outbox.enqueue({
      ...promptEntry(`prompt-cap-${index}`),
      createdAt: new Date((index + 1) * 1000).toISOString(),
    }), true);
  }

  const pending = outbox.listPending();
  assert.equal(pending.length, outbox.MAX_PENDING_ENTRIES);
  assert.equal(pending.some((entry) => entry.id === 'response-consumed'), true);
  assert.equal(pending.some((entry) => entry.id === 'prompt-cap-0'), false);
  assert.equal(pending.some((entry) => entry.id === `prompt-cap-${outbox.MAX_PENDING_ENTRIES - 1}`), true);
});
test('response-only cap fails closed without evicting an existing response', () => {
  for (let index = 0; index < outbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(outbox.enqueue({
      ...responseEntry(`response-cap-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }

  assert.equal(outbox.enqueue(responseEntry('response-cap-overflow')), false);
  const pending = outbox.listPending();
  assert.equal(pending.length, outbox.MAX_PENDING_ENTRIES);
  assert.equal(pending.some((entry) => entry.id === 'response-cap-0'), true);
  assert.equal(pending.some((entry) => entry.id === 'response-cap-overflow'), false);
});
test('keeps a successful prompt queued until its server id promotion is durable', async () => {
  const intent = {
    id: 'prompt-promotion',
    kind: 'prompt',
    payload: { prompt_text: 'prompt' },
    promotion: {
      sessionId: 'session-promotion',
      epoch: 1,
      clientEventId: 'event-promotion',
      hostPromptId: 'host-promotion',
    },
  };
  assert.equal(outbox.enqueue(intent), true);
  const first = await outbox.drain(async () => ({ status: 201, body: '{"id":"server"}', ack: false }));
  assert.equal(first[0].acked, false);
  assert.equal(outbox.listPending().length, 1);

  const second = await outbox.drain(async () => ({ status: 201, body: '{"id":"server"}', ack: true }));
  assert.equal(second[0].acked, true);
  assert.deepEqual(outbox.listPending(), []);
});
test('drain delivers a response after only its own pending prompt dependency', async () => {
  for (let index = 0; index < 32; index += 1) {
    assert.equal(outbox.enqueue({
      ...promptEntry(`stuck-unrelated-prompt-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }
  assert.equal(outbox.enqueue({
    ...promptEntry('prompt-required-by-response'),
    createdAt: new Date(33_000).toISOString(),
  }), true);
  assert.equal(outbox.enqueue({
    ...responseEntry('response-not-starved', 'prompt-required-by-response'),
    createdAt: new Date(34_000).toISOString(),
  }), true);

  const sent = [];
  await outbox.drain(async (entry) => {
    sent.push(entry.id);
    return { status: entry.id.startsWith('stuck-') ? 503 : 202 };
  }, { limit: 2 });

  assert.deepEqual(sent, ['prompt-required-by-response', 'response-not-starved']);
  assert.equal(outbox.listPending().some((entry) => entry.id === 'response-not-starved'), false);
});
test('same intent validates after JSON serialization drops undefined response fields', () => {
  const intent = {
    ...responseEntry('response-undefined-fields'),
    payload: {
      response_text: 'complete',
      model: undefined,
      cost_usd: undefined,
    },
  };
  assert.equal(outbox.enqueue(intent), true);
  assert.equal(outbox.enqueue(intent), true);
  const [pending] = outbox.listPending();
  assert.equal(outbox.listPending().length, 1);
  assert.equal(pending.id, intent.id);
  assert.deepEqual(pending.payload, { response_text: 'complete' });
});
test('replays only the prompt matching a promotion correlation', async () => {
  const prompt = {
    id: 'prompt-targeted-replay',
    kind: 'prompt',
    payload: { prompt_text: 'prompt' },
    promotion: {
      sessionId: 'target-session',
      epoch: 2,
      clientEventId: 'target-event',
      hostPromptId: 'target-host-prompt',
    },
  };
  assert.equal(outbox.enqueue(responseEntry('unrelated-response')), true);
  assert.equal(outbox.enqueue(prompt), true);

  const sent = [];
  const outcomes = await outbox.replayPrompt({
    sessionId: 'target-session',
    epoch: 2,
    clientEventId: 'target-event',
    hostPromptId: 'target-host-prompt',
  }, async (entry) => {
    sent.push(entry.id);
    return { status: 201, ack: true };
  });

  assert.deepEqual(sent, ['prompt-targeted-replay']);
  assert.deepEqual(outcomes.map(({ id, acked }) => ({ id, acked })), [{ id: 'prompt-targeted-replay', acked: true }]);
  assert.deepEqual(outbox.listPending().map((entry) => entry.id), ['unrelated-response']);
});
test('drain and replayPrompt count large backlog lookup time against their deadlines', async () => {
  for (let index = 0; index < 31; index += 1) {
    assert.equal(outbox.enqueue(responseEntry(`lookup-backlog-${index}`)), true);
  }
  assert.equal(outbox.enqueue({
    id: 'prompt-lookup-target',
    kind: 'prompt',
    payload: { prompt_text: 'target' },
    promotion: {
      sessionId: 'lookup-session',
      epoch: 1,
      clientEventId: 'lookup-event',
      hostPromptId: 'lookup-host',
    },
  }), true);

  const originalReadFileSync = fs.readFileSync;
  const outboxDir = `${outbox.getOutboxDir()}${path.sep}`;
  let sends = 0;
  fs.readFileSync = function delayedOutboxRead(file, ...args) {
    if (typeof file === 'string' && file.startsWith(outboxDir)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return originalReadFileSync.call(this, file, ...args);
  };
  let drainOutcomes;
  let replayOutcomes;
  try {
    drainOutcomes = await outbox.drain(async () => {
      sends += 1;
      return { status: 202 };
    }, { maxElapsedMs: 100, minRequestMs: 25 });
    replayOutcomes = await outbox.replayPrompt({
      sessionId: 'lookup-session',
      epoch: 1,
      clientEventId: 'lookup-event',
      hostPromptId: 'lookup-host',
    }, async () => {
      sends += 1;
      return { status: 202 };
    }, { maxElapsedMs: 100, minRequestMs: 25 });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.deepEqual(drainOutcomes, []);
  assert.deepEqual(replayOutcomes, []);
  assert.equal(sends, 0);
});

test('prioritizes the current intent and bounds a replay pass', async () => {
  for (let index = 0; index < 33; index += 1) {
    assert.equal(outbox.enqueue({
      ...responseEntry(`older-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }
  assert.equal(outbox.enqueue({
    ...responseEntry('current'),
    createdAt: new Date(34 * 1000).toISOString(),
  }), true);

  const sent = [];
  const outcomes = await outbox.drain(async (entry) => {
    sent.push(entry.id);
    return { status: 202 };
  }, { limit: 2, maxElapsedMs: 2000, prioritizeIds: ['current'] });

  assert.deepEqual(sent, ['current', 'older-0']);
  assert.equal(outcomes.length, 2);
  assert.equal(outbox.listPending().length, 32);
});

test('repairs a corrupt EEXIST final and rejects a conflicting final as durable', () => {
  const intent = {
    ...responseEntry('repair-final'),
    createdAt: '2026-07-17T00:00:00.000Z',
  };
  fs.mkdirSync(outbox.getOutboxDir(), { recursive: true });
  fs.writeFileSync(entryFile(intent.id), '{corrupt');
  assert.equal(outbox.enqueue(intent), true);
  assert.deepEqual(outbox.listPending(), [{ ...intent }]);
  assert.ok(fs.readdirSync(outbox.getOutboxDir()).some((name) => name.endsWith('.corrupt')));
  assert.equal(outbox.enqueue({ ...intent, createdAt: '2026-07-17T00:01:00.000Z' }), true);

  assert.equal(outbox.enqueue({
    ...intent,
    payload: { response_text: 'conflicting' },
  }), false);
  assert.deepEqual(outbox.listPending(), [{ ...intent }]);
});

test('reaps aged orphan temps without deleting a live publisher temp', () => {
  fs.mkdirSync(outbox.getOutboxDir(), { recursive: true });
  const orphan = path.join(outbox.getOutboxDir(), '.00000000-0000-4000-8000-000000000000.tmp');
  const live = path.join(outbox.getOutboxDir(), '.00000000-0000-4000-8000-000000000001.tmp');
  fs.writeFileSync(orphan, 'orphan');
  fs.writeFileSync(live, 'live');
  const old = new Date(Date.now() - outbox.ORPHAN_TEMP_AGE_MS - 1_000);
  fs.utimesSync(orphan, old, old);

  assert.equal(outbox.enqueue(responseEntry('after-orphan')), true);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(live), true);
});

test('logs prompt eviction at the outbox cap', () => {
  for (const modulePath of ['../lib/response-outbox', '../lib/debug', '../lib/env']) {
    delete require.cache[require.resolve(modulePath)];
  }
  const freshOutbox = require('../lib/response-outbox');
  for (let index = 0; index <= freshOutbox.MAX_PENDING_ENTRIES; index += 1) {
    assert.equal(freshOutbox.enqueue({
      ...promptEntry(`debug-cap-${index}`),
      createdAt: new Date(index * 1000).toISOString(),
    }), true);
  }
  assert.match(fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'debug.log'), 'utf8'), /DROP outbox prompt beyond cap/);
});
