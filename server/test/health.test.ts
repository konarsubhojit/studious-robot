import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/index.ts';
import { createMemoryStores } from '../src/stores/index.ts';
import { asMessageStore, listenOnRandomPort, readJson } from './helpers.ts';

test('GET /health returns ok status', async () => {
  const { httpServer } = createServer();
  const port = await listenOnRandomPort(httpServer);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'wetalk-signaling');
    assert.deepEqual(body.messageStore, { type: 'memory', status: 'ready' });
    // Sessions/calls/presence are per-process maps, so a deployment must pin a
    // client to one instance. Asserted here so the guarantee is not quietly
    // dropped from the probe payload deployments read it from.
    assert.equal(body.stateAffinity, 'sticky');
    assert.equal(typeof body.instanceId, 'string');
    assert.deepEqual(body.sharedState, { calls: false, messageBus: false });
    assert.equal(typeof body.uptime, 'number');
    assert.equal(typeof body.timestamp, 'string');
  } finally {
    await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
  }
});

test('GET /health names the message-store backend and reports it ready', async () => {
  const messageStore = asMessageStore({ type: 'postgres' as const, close: async () => {} });
  const { httpServer } = createServer({ messageStore });
  const port = await listenOnRandomPort(httpServer);

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    // Both backends are usable the moment they are constructed: the Postgres
    // store borrows the pool `db/client.ts` has already established, so there
    // is no separate connection to wait on and no "starting" window in which
    // the store exists but cannot serve reads.
    assert.deepEqual(body.messageStore, { type: 'postgres', status: 'ready' });
  } finally {
    await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
  }
});

test('GET /health reports shared affinity metadata when shared stores are configured', async () => {
  const stores = Object.assign(createMemoryStores(), {
    stateAffinity: 'shared' as const,
    instanceId: 'instance-test',
    callState: {
      get: async () => null,
      save: async () => {},
      transitionAtomic: async () => ({ ok: false as const, error: 'not_found' as const }),
      acquireSweepLease: async () => true,
      releaseSweepLease: async () => {},
    },
  });
  const { httpServer } = createServer({ stores });
  const port = await listenOnRandomPort(httpServer);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.stateAffinity, 'shared');
    assert.equal(body.instanceId, 'instance-test');
    assert.deepEqual(body.sharedState, { calls: true, messageBus: false });
  } finally {
    await new Promise((resolve) => httpServer.close(() => resolve(undefined)));
  }
});
