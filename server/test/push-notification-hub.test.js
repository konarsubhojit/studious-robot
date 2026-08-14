'use strict';

/**
 * Unit tests for the Azure Notification Hubs push transport.
 *
 * Strategy: identical to `push-fcm-v1.test.js` — `https.request` is
 * monkey-patched so the Notification Hubs REST call, the OAuth2 token exchange
 * and the FCM v1 send can all be scripted without network traffic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');

const push = require('../src/push.js');

// A throwaway RSA key so the FCM fallback path can sign its JWT.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'fcm@demo-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
};

const HUB_NAMESPACE = 'apns-kiyon.servicebus.windows.net';
const CONNECTION_STRING =
  `Endpoint=sb://${HUB_NAMESPACE}/;SharedAccessKeyName=DefaultFullSharedAccessSignature;` +
  'SharedAccessKey=c2hhcmVkLWFjY2Vzcy1rZXk=';

const CHANNEL_FCM  = { provider: 'fcm', pushToken: 'device-token-123', deviceId: 'dev-1' };
const CHANNEL_APNS = { provider: 'apns', pushToken: 'apns-token-123', deviceId: 'dev-2' };
const CALL = { callId: 'call-abc', callerId: 'alice' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Install a fake `https.request` driven by a per-call handler.
 *
 * @param {(opts: object, body: Buffer) => { statusCode: number, body: string }} handler
 */
function mockHttps(handler) {
  const original = https.request;
  const requests = [];

  https.request = (opts, callback) => {
    const chunks = [];
    const req = new EventEmitter();
    req.end = (data) => {
      if (data) chunks.push(data);
      const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      requests.push({ opts, body: body.toString('utf8') });

      const { statusCode, body: resBody } = handler(opts, body);
      const res = new EventEmitter();
      res.statusCode = statusCode;
      setImmediate(() => {
        callback(res);
        if (resBody) res.emit('data', Buffer.from(resBody));
        res.emit('end');
      });
    };
    return req;
  };

  return {
    requests,
    restore: () => { https.request = original; },
  };
}

function captureConsoleLog() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  return {
    lines,
    restore: () => { console.log = original; },
  };
}

/** Run `fn` with the given push-related env vars applied, restoring them after. */
function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  push._resetFcmTokenCache();
  push._resetNotificationHubTokenCache();
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    push._resetFcmTokenCache();
    push._resetNotificationHubTokenCache();
  });
}

const HUB_ENV = {
  AZURE_NOTIFICATION_HUB_CONNECTION_STRING: CONNECTION_STRING,
  AZURE_NOTIFICATION_HUB_NAME: 'storeman',
  AZURE_NOTIFICATION_HUB_API_VERSION: undefined,
};

// ─── Connection-string parsing ────────────────────────────────────────────────

test('parses a DefaultFullSharedAccessSignature connection string', async () => {
  await withEnv(HUB_ENV, () => {
    const config = push._loadNotificationHubConfig();
    assert.equal(config.endpoint, `https://${HUB_NAMESPACE}/`);
    assert.equal(config.keyName, 'DefaultFullSharedAccessSignature');
    assert.equal(config.key, 'c2hhcmVkLWFjY2Vzcy1rZXk=');
    assert.equal(config.hubName, 'storeman');
    assert.equal(config.apiVersion, '2015-01');
  });
});

test('honours an explicit api-version override', async () => {
  await withEnv({ ...HUB_ENV, AZURE_NOTIFICATION_HUB_API_VERSION: '2020-06' }, () => {
    assert.equal(push._loadNotificationHubConfig().apiVersion, '2020-06');
  });
});

test('returns null when the hub name is missing', async () => {
  await withEnv({ ...HUB_ENV, AZURE_NOTIFICATION_HUB_NAME: undefined }, () => {
    assert.equal(push._loadNotificationHubConfig(), null);
  });
});

test('returns null when the connection string is missing', async () => {
  await withEnv({ ...HUB_ENV, AZURE_NOTIFICATION_HUB_CONNECTION_STRING: undefined }, () => {
    assert.equal(push._loadNotificationHubConfig(), null);
  });
});

test('returns null when the connection string is malformed', async () => {
  const malformed = [
    'not-a-connection-string',
    `Endpoint=sb://${HUB_NAMESPACE}/;SharedAccessKeyName=policy`, // no key
    'SharedAccessKeyName=policy;SharedAccessKey=abc',            // no endpoint
  ];
  for (const value of malformed) {
    await withEnv({ ...HUB_ENV, AZURE_NOTIFICATION_HUB_CONNECTION_STRING: value }, () => {
      assert.equal(push._loadNotificationHubConfig(), null, `expected null for "${value}"`);
    });
  }
});

// ─── SAS token ────────────────────────────────────────────────────────────────

test('builds a SharedAccessSignature token with the required fields', async () => {
  await withEnv(HUB_ENV, () => {
    const config = push._loadNotificationHubConfig();
    const uri = `https://${HUB_NAMESPACE}/storeman`;
    const token = push._buildNotificationHubSasToken(config, uri);

    assert.ok(token.startsWith('SharedAccessSignature '), 'has the SAS scheme prefix');
    const params = new URLSearchParams(token.slice('SharedAccessSignature '.length));
    assert.equal(params.get('sr'), uri);
    assert.equal(params.get('skn'), 'DefaultFullSharedAccessSignature');
    assert.ok(params.get('sig').length > 0, 'signature present');
    assert.ok(Number(params.get('se')) > Math.floor(Date.now() / 1000), 'expiry is in the future');
  });
});

test('caches the SAS token and refreshes it once expired', async () => {
  await withEnv(HUB_ENV, () => {
    const config = push._loadNotificationHubConfig();
    const uri = `https://${HUB_NAMESPACE}/storeman`;

    const first = push._buildNotificationHubSasToken(config, uri);
    assert.equal(push._buildNotificationHubSasToken(config, uri), first, 'cached token reused');

    // Jump past the token lifetime; the next call must mint a fresh token.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60 * 60 * 1000;
    try {
      assert.notEqual(push._buildNotificationHubSasToken(config, uri), first, 'token refreshed');
    } finally {
      Date.now = realNow;
    }
  });
});

// ─── Payload shape ────────────────────────────────────────────────────────────

test('android hub payload is data-only and carries the call fields', () => {
  const payload = push._buildNotificationHubAndroidPayload(CALL);
  assert.equal(payload.notification, undefined, 'no notification block');
  assert.equal(payload.priority, 'high');
  assert.deepEqual(payload.data, {
    callId: 'call-abc',
    callerId: 'alice',
    type: 'call.incoming',
    deepLink: 'wetalk://call/call-abc',
    title: 'Incoming call',
    body: 'Call from alice',
  });
});

// ─── Delivery / fallback ──────────────────────────────────────────────────────

test('delivers through the notification hub when configured', async () => {
  await withEnv({ ...HUB_ENV, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT) }, async () => {
    const mock = mockHttps(() => ({ statusCode: 201, body: '' }));
    try {
      const result = await push.sendIncomingCallPush(CHANNEL_FCM, CALL);
      assert.equal(result.ok, true);
      assert.equal(result.transport, 'notification_hub');
      assert.equal(result.provider, 'fcm');
      assert.equal(result.deviceId, 'dev-1');

      assert.equal(mock.requests.length, 1, 'no direct provider request attempted');
      const [hubReq] = mock.requests;
      assert.equal(hubReq.opts.hostname, HUB_NAMESPACE);
      assert.equal(hubReq.opts.path, '/storeman/messages/?direct&api-version=2015-01');
      assert.equal(hubReq.opts.headers['ServiceBusNotification-Format'], 'gcm');
      assert.equal(hubReq.opts.headers['ServiceBusNotification-DeviceHandle'], 'device-token-123');
      assert.equal(hubReq.opts.headers['Content-Type'], 'application/json;charset=utf-8');
      assert.ok(String(hubReq.opts.headers.Authorization).startsWith('SharedAccessSignature '));

      const body = JSON.parse(hubReq.body);
      assert.equal(body.notification, undefined);
      assert.equal(body.data.callId, 'call-abc');
      assert.equal(body.priority, 'high');
    } finally {
      mock.restore();
    }
  });
});

test('uses the apple format for APNs devices', async () => {
  await withEnv(HUB_ENV, async () => {
    const mock = mockHttps(() => ({ statusCode: 200, body: '' }));
    try {
      const result = await push.sendIncomingCallPush(CHANNEL_APNS, CALL);
      assert.equal(result.ok, true);
      assert.equal(result.transport, 'notification_hub');

      const [hubReq] = mock.requests;
      assert.equal(hubReq.opts.headers['ServiceBusNotification-Format'], 'apple');
      const body = JSON.parse(hubReq.body);
      assert.equal(body.aps.alert.title, 'Incoming call');
      assert.equal(body.deepLink, 'wetalk://call/call-abc');
    } finally {
      mock.restore();
    }
  });
});

test('falls back to direct FCM when the notification hub rejects the send', async () => {
  await withEnv({ ...HUB_ENV, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT) }, async () => {
    const mock = mockHttps((opts) => {
      if (opts.hostname === HUB_NAMESPACE) {
        return { statusCode: 400, body: JSON.stringify({ Message: 'Device handle is invalid.' }) };
      }
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      return { statusCode: 200, body: '{}' };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL_FCM, CALL);
      assert.equal(result.ok, true, 'direct FCM delivered the message');
      assert.equal(result.transport, 'direct');

      const hubRequests = mock.requests.filter((r) => r.opts.hostname === HUB_NAMESPACE);
      const fcmRequests = mock.requests.filter((r) => r.opts.hostname === 'fcm.googleapis.com');
      assert.equal(hubRequests.length, 1, '400 is not retried');
      assert.equal(fcmRequests.length, 1, 'fell back to the direct provider');
    } finally {
      mock.restore();
    }
  });
});

test('surfaces the direct failure when both transports fail', async () => {
  await withEnv({ ...HUB_ENV, FCM_SERVICE_ACCOUNT_JSON: undefined }, async () => {
    const mock = mockHttps(() => ({ statusCode: 401, body: 'Unauthorized' }));
    try {
      const result = await push.sendIncomingCallPush(CHANNEL_FCM, CALL);
      assert.equal(result.ok, false);
      assert.equal(result.transport, 'direct');
      assert.equal(result.reason, 'fcm_not_configured');
    } finally {
      mock.restore();
    }
  });
});

test('goes straight to the direct path when the hub is not configured', async () => {
  await withEnv({
    AZURE_NOTIFICATION_HUB_CONNECTION_STRING: undefined,
    AZURE_NOTIFICATION_HUB_NAME: undefined,
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT),
  }, async () => {
    const logs = captureConsoleLog();
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      return { statusCode: 200, body: '{}' };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL_FCM, CALL);
      assert.equal(result.ok, true);
      assert.equal(result.transport, 'direct');
      assert.equal(
        mock.requests.filter((r) => r.opts.hostname === HUB_NAMESPACE).length,
        0,
        'no notification hub request issued',
      );
      assert.ok(
        logs.lines.some((line) =>
          line.includes('[push] Skipped Notification Hub') &&
          line.includes('device=dev-1') &&
          line.includes('reason=notification_hub_not_configured')),
        'hub-not-configured skip should be logged for the device',
      );
    } finally {
      logs.restore();
      mock.restore();
    }
  });
});

// ─── Message pushes ───────────────────────────────────────────────────────────

test('sendMessagePush emits a data-only message payload through the hub', async () => {
  await withEnv(HUB_ENV, async () => {
    const mock = mockHttps(() => ({ statusCode: 201, body: '' }));
    try {
      const result = await push.sendMessagePush(CHANNEL_FCM, {
        messageId: 'msg-1',
        conversationId: 'alice|bob',
        senderId: 'alice',
      });
      assert.equal(result.ok, true);
      assert.equal(result.transport, 'notification_hub');

      const body = JSON.parse(mock.requests[0].body);
      assert.equal(body.notification, undefined);
      assert.equal(body.data.type, 'message.received');
      assert.equal(body.data.messageId, 'msg-1');
      assert.equal(body.data.deepLink, 'wetalk://chat/alice|bob');
    } finally {
      mock.restore();
    }
  });
});
