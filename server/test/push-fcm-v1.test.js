'use strict';

/**
 * Unit tests for the FCM HTTP v1 push delivery path.
 *
 * Strategy: the push module performs real `https.request` calls to two
 * endpoints — the OAuth2 token endpoint and the FCM v1 `messages:send`
 * endpoint.  We monkey-patch `https.request` to capture the outgoing requests
 * and return scripted responses, so no network traffic occurs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { generateKeyPairSync } = require('node:crypto');

const push = require('../src/push.js');

// A throwaway RSA key so JWT signing succeeds without a real service account.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'fcm@demo-project.iam.gserviceaccount.com',
  private_key: PRIVATE_KEY_PEM,
  token_uri: 'https://oauth2.googleapis.com/token',
};

/**
 * Install a fake `https.request` driven by a per-call handler.
 *
 * @param {(opts: object, body: Buffer) => { statusCode: number, body: string }} handler
 * @returns {{ requests: Array<{opts: object, body: string}>, restore: () => void }}
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
      const record = { opts, body: body.toString('utf8') };
      requests.push(record);

      const { statusCode, body: resBody } = handler(opts, body);
      const res = new EventEmitter();
      res.statusCode = statusCode;
      // Deliver asynchronously to mimic real I/O ordering.
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
    restore: () => {
      https.request = original;
    },
  };
}

function withFcmEnv(value, fn) {
  const prev = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (value === undefined) {
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  } else {
    process.env.FCM_SERVICE_ACCOUNT_JSON = value;
  }
  push._resetFcmTokenCache();
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    else process.env.FCM_SERVICE_ACCOUNT_JSON = prev;
    push._resetFcmTokenCache();
  });
}

const CHANNEL = { provider: 'fcm', pushToken: 'device-token-123', deviceId: 'dev-1' };
const CALL = { callId: 'call-abc', callerId: 'alice' };

test('returns fcm_not_configured when FCM_SERVICE_ACCOUNT_JSON is absent', async () => {
  await withFcmEnv(undefined, async () => {
    const result = await push.sendIncomingCallPush(CHANNEL, CALL);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fcm_not_configured');
    assert.equal(result.provider, 'fcm');
  });
});

test('returns fcm_not_configured when service account JSON is malformed', async () => {
  await withFcmEnv('{ not json', async () => {
    const result = await push.sendIncomingCallPush(CHANNEL, CALL);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'fcm_not_configured');
  });
});

test('acquires an OAuth2 token then posts a valid v1 message payload', async () => {
  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return {
          statusCode: 200,
          body: JSON.stringify({ access_token: 'ya29.test-token', expires_in: 3599 }),
        };
      }
      // FCM v1 endpoint.
      return {
        statusCode: 200,
        body: JSON.stringify({ name: 'projects/demo-project/messages/1' }),
      };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL, CALL);
      assert.equal(result.ok, true);
      assert.equal(result.statusCode, 200);

      // Two requests: token exchange, then the message send.
      assert.equal(mock.requests.length, 2);

      const [tokenReq, sendReq] = mock.requests;
      assert.equal(tokenReq.opts.hostname, 'oauth2.googleapis.com');
      assert.match(
        tokenReq.body,
        /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/
      );
      assert.match(tokenReq.body, /assertion=/);

      assert.equal(sendReq.opts.hostname, 'fcm.googleapis.com');
      assert.equal(sendReq.opts.path, '/v1/projects/demo-project/messages:send');
      const authParts = String(sendReq.opts.headers.Authorization).split(' ');
      assert.equal(authParts[0], 'Bearer');
      assert.ok(authParts[1] && authParts[1].length > 0, 'access token attached');

      const payload = JSON.parse(sendReq.body);
      assert.equal(payload.message.token, 'device-token-123');
      // Data-only message: no top-level `notification` block, so the app's
      // background message handler fires CallKeep even when backgrounded/killed.
      assert.equal(payload.message.notification, undefined);
      assert.equal(payload.message.data.title, 'Incoming call');
      assert.equal(payload.message.data.body, 'Call from alice');
      assert.equal(payload.message.data.callId, 'call-abc');
      assert.equal(payload.message.data.callerId, 'alice');
      assert.equal(payload.message.data.type, 'call.incoming');
      assert.equal(payload.message.data.deepLink, 'wetalk://call/call-abc');
      assert.equal(payload.message.android.priority, 'HIGH');
      assert.equal(payload.message.android.ttl, '120s');
      assert.equal(payload.message.apns.headers['apns-priority'], '10');
      assert.ok(
        Number(payload.message.apns.headers['apns-expiration']) > Math.floor(Date.now() / 1000),
      );
    } finally {
      mock.restore();
    }
  });
});

test('reuses the cached access token across sends', async () => {
  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return {
          statusCode: 200,
          body: JSON.stringify({ access_token: 'ya29.cached', expires_in: 3599 }),
        };
      }
      return { statusCode: 200, body: '{}' };
    });

    try {
      await push.sendIncomingCallPush(CHANNEL, CALL);
      await push.sendIncomingCallPush(CHANNEL, CALL);

      const tokenRequests = mock.requests.filter(
        (r) => r.opts.hostname === 'oauth2.googleapis.com'
      );
      const sendRequests = mock.requests.filter((r) => r.opts.hostname === 'fcm.googleapis.com');
      assert.equal(tokenRequests.length, 1, 'token acquired only once');
      assert.equal(sendRequests.length, 2, 'two messages sent');
    } finally {
      mock.restore();
    }
  });
});

test('surfaces the FCM v1 error status on a non-200 send response', async () => {
  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' },
        }),
      };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL, CALL);
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 404);
      assert.equal(result.reason, 'NOT_FOUND');
    } finally {
      mock.restore();
    }
  });
});

test('retries on a transient 5xx send failure then succeeds', async () => {
  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    let sendAttempts = 0;
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return { statusCode: 503, body: JSON.stringify({ error: { status: 'UNAVAILABLE' } }) };
      }
      return { statusCode: 200, body: '{}' };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL, CALL);
      assert.equal(result.ok, true);
      assert.equal(sendAttempts, 2, 'second attempt succeeds after a 503');
    } finally {
      mock.restore();
    }
  });
});

test('flags a 404/UNREGISTERED FCM v1 response as a dead token', async () => {
  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: { status: 'UNREGISTERED', message: 'Requested entity was not found.' },
        }),
      };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL, CALL);
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 404);
      assert.equal(result.reason, 'UNREGISTERED');
      assert.equal(
        result.deadToken,
        true,
        'a 404/UNREGISTERED response must be flagged as a dead token'
      );
    } finally {
      mock.restore();
    }
  });
});

test('flags a 400/INVALID_ARGUMENT FCM v1 response as a dead token', async () => {
  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: { status: 'INVALID_ARGUMENT', message: 'Invalid registration token.' },
        }),
      };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL, CALL);
      assert.equal(result.ok, false);
      assert.equal(result.statusCode, 400);
      assert.equal(result.reason, 'INVALID_ARGUMENT');
      assert.equal(
        result.deadToken,
        true,
        'a 400/INVALID_ARGUMENT response must be flagged as a dead token'
      );
    } finally {
      mock.restore();
    }
  });
});

test('does not flag a transient 503 as a dead token, and does not retry a 404', async () => {
  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    let sendAttempts = 0;
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      sendAttempts += 1;
      return {
        statusCode: 404,
        body: JSON.stringify({ error: { status: 'UNREGISTERED' } }),
      };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL, CALL);
      assert.equal(result.deadToken, true);
      assert.equal(sendAttempts, 1, '404/UNREGISTERED must not be retried');
    } finally {
      mock.restore();
    }
  });

  await withFcmEnv(JSON.stringify(SERVICE_ACCOUNT), async () => {
    const mock = mockHttps((opts) => {
      if (opts.hostname === 'oauth2.googleapis.com') {
        return { statusCode: 200, body: JSON.stringify({ access_token: 'ya29.test' }) };
      }
      return { statusCode: 503, body: JSON.stringify({ error: { status: 'UNAVAILABLE' } }) };
    });

    try {
      const result = await push.sendIncomingCallPush(CHANNEL, CALL);
      assert.equal(result.ok, false);
      assert.equal(result.deadToken, false, 'a transient 503 must not be flagged as a dead token');
    } finally {
      mock.restore();
    }
  });
});

test('_isDeadTokenResult recognizes dead-token codes/reasons and rejects others', () => {
  assert.equal(
    push._isDeadTokenResult({ ok: false, statusCode: 404, reason: 'UNREGISTERED' }),
    true
  );
  assert.equal(
    push._isDeadTokenResult({ ok: false, statusCode: 400, reason: 'INVALID_ARGUMENT' }),
    true
  );
  assert.equal(
    push._isDeadTokenResult({ ok: true, statusCode: 404, reason: 'UNREGISTERED' }),
    false,
    'ok results are never dead'
  );
  assert.equal(
    push._isDeadTokenResult({ ok: false, statusCode: 503, reason: 'UNAVAILABLE' }),
    false
  );
  assert.equal(
    push._isDeadTokenResult({ ok: false, statusCode: 429, reason: 'RESOURCE_EXHAUSTED' }),
    false
  );
  assert.equal(
    push._isDeadTokenResult({ ok: false, statusCode: 404, reason: 'NOT_FOUND' }),
    false,
    'unrelated 404 reasons are not dead tokens'
  );
  assert.equal(
    push._isDeadTokenResult({ ok: false, statusCode: null, reason: 'network error' }),
    false
  );
});
