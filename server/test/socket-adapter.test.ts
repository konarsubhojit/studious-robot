import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WEB_PUBSUB_HUB,
  attachSocketAdapter,
  resolveWebPubSubHub,
  selectSocketTransport,
} from '../src/lib/socketAdapter.ts';
import { asSocketIoServer } from './helpers.ts';

const io = asSocketIoServer({});

test('the Redis adapter is the transport whenever the Web PubSub flag is unset', async () => {
  const attached: unknown[] = [];
  const result = await attachSocketAdapter({
    io,
    attachRedisAdapter: (server) => attached.push(server),
    env: {},
    useAzureSocketIO: () => {
      throw new Error('the Web PubSub integration must not be consulted when unconfigured');
    },
  });

  assert.equal(selectSocketTransport({}), 'redis-adapter');
  assert.equal(result.transport, 'redis-adapter');
  assert.equal(result.reason, 'web_pubsub_not_configured');
  assert.deepEqual(attached, [io]);
});

test('a blank connection string is treated as unset', async () => {
  const result = await attachSocketAdapter({
    io,
    attachRedisAdapter: () => {},
    env: { WEB_PUBSUB_CONNECTION_STRING: '   ' },
  });
  assert.equal(result.transport, 'redis-adapter');
  assert.equal(result.reason, 'web_pubsub_not_configured');
});

test('a configured connection string routes fan-out through Web PubSub instead of Redis', async () => {
  const calls: { hub: string; connectionString: string }[] = [];
  let redisAttached = false;
  const result = await attachSocketAdapter({
    io,
    attachRedisAdapter: () => {
      redisAttached = true;
    },
    env: {
      WEB_PUBSUB_CONNECTION_STRING: 'Endpoint=https://example.webpubsub.azure.com;AccessKey=test;',
      WEB_PUBSUB_HUB: 'signaling-test',
    },
    useAzureSocketIO: (_server, options) => {
      calls.push(options);
    },
  });

  assert.equal(result.transport, 'web-pubsub');
  assert.equal(result.reason, 'web_pubsub_attached');
  assert.equal(redisAttached, false);
  assert.deepEqual(calls, [
    {
      hub: 'signaling-test',
      connectionString: 'Endpoint=https://example.webpubsub.azure.com;AccessKey=test;',
    },
  ]);
});

test('the hub defaults when WEB_PUBSUB_HUB is unset', async () => {
  assert.equal(resolveWebPubSubHub({}), DEFAULT_WEB_PUBSUB_HUB);
  const hubs: string[] = [];
  await attachSocketAdapter({
    io,
    env: { WEB_PUBSUB_CONNECTION_STRING: 'Endpoint=https://example;AccessKey=k;' },
    useAzureSocketIO: (_server, options) => {
      hubs.push(options.hub);
    },
  });
  assert.deepEqual(hubs, [DEFAULT_WEB_PUBSUB_HUB]);
});

test('a failing Web PubSub initialisation degrades to the Redis adapter and says so', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
  let redisAttached = false;
  try {
    const result = await attachSocketAdapter({
      io,
      attachRedisAdapter: () => {
        redisAttached = true;
      },
      env: { WEB_PUBSUB_CONNECTION_STRING: 'Endpoint=https://example;AccessKey=k;' },
      useAzureSocketIO: () => {
        throw new Error('negotiate failed');
      },
    });

    assert.equal(result.transport, 'redis-adapter');
    assert.equal(result.reason, 'web_pubsub_init_failed');
    assert.match(result.detail, /negotiate failed/);
    assert.equal(redisAttached, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /web_pubsub_init_failed/);
  } finally {
    console.error = originalError;
  }
});

test('a rejected Web PubSub initialisation is treated the same as a thrown one', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await attachSocketAdapter({
      io,
      env: { WEB_PUBSUB_CONNECTION_STRING: 'Endpoint=https://example;AccessKey=k;' },
      useAzureSocketIO: () => Promise.reject(new Error('unauthorized')),
    });
    assert.equal(result.transport, 'redis-adapter');
    assert.equal(result.reason, 'web_pubsub_init_failed');
  } finally {
    console.error = originalError;
  }
});

test('a missing @azure/web-pubsub-socket.io install falls back rather than crashing the boot', async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };
  let redisAttached = false;
  try {
    // No `useAzureSocketIO` seam, so the real (optional, uninstalled)
    // dependency is resolved by import and the import failure is what is
    // being exercised here.
    const result = await attachSocketAdapter({
      io,
      attachRedisAdapter: () => {
        redisAttached = true;
      },
      env: { WEB_PUBSUB_CONNECTION_STRING: 'Endpoint=https://example;AccessKey=k;' },
    });

    assert.equal(result.transport, 'redis-adapter');
    assert.equal(result.reason, 'web_pubsub_dependency_missing');
    assert.equal(redisAttached, true);
    assert.match(errors[0], /web_pubsub_dependency_missing/);
  } finally {
    console.error = originalError;
  }
});

test('a single-process deployment without a Redis bundle still reports the default transport', async () => {
  const result = await attachSocketAdapter({ io, env: {} });
  assert.equal(result.transport, 'redis-adapter');
});
