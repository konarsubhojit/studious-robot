/**
 * Unit tests for the pure halves of push delivery (`src/push/`).
 *
 * Everything covered here used to be reachable only through a mocked HTTPS
 * stack, because it lived in the same file as the transport: whether a failure
 * is retryable, whether it means the token is dead, which `x-ms-*` headers are
 * kept for correlation, and what a connection string parses into. Splitting
 * `push.ts` made each of them a function over plain data, so they are asserted
 * here directly — no provider, no sockets, no environment beyond the couple of
 * variables the config loader reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNotificationHubConnectionString } from '../src/push/credentials.ts';
import {
  buildCallCancelledEnvelope,
  buildCallEnvelope,
  buildMessageEnvelope,
  resolveCallTtlSeconds,
} from '../src/push/envelopes.ts';
import { isDeadTokenResult, isRetryable } from '../src/push/outcomes.ts';
import { extractNotificationHubCorrelationHeaders } from '../src/push/transport.ts';

// ─── Envelopes ────────────────────────────────────────────────────────────────

test('a call envelope carries the ids the client needs to ring', () => {
  const envelope = buildCallEnvelope({ callId: 'call-1', callerId: 'alice' });

  assert.equal(envelope.type, 'call.incoming');
  assert.equal(envelope.deepLink, 'wetalk://call/call-1');
  assert.deepEqual(envelope.data, { callId: 'call-1', callerId: 'alice' });
});

test('a call TTL tracks the time left in the ring window', () => {
  const inTwentySeconds = new Date(Date.now() + 20_000).toISOString();
  const ttl = resolveCallTtlSeconds(inTwentySeconds);

  assert.ok(ttl > 0 && ttl <= 20, `expected a TTL of at most 20s, got ${ttl}`);
  // A push must never outlive the ring, so an already-elapsed deadline still
  // produces a positive (but minimal) TTL rather than a negative one.
  assert.equal(resolveCallTtlSeconds(new Date(Date.now() - 60_000).toISOString()), 1);
  // No deadline, or an unparseable one, falls back to the default ring window.
  assert.equal(resolveCallTtlSeconds(null), 120);
  assert.equal(resolveCallTtlSeconds('not a date'), 120);
});

test('a cancelled-call envelope expires quickly and names the reason', () => {
  const envelope = buildCallCancelledEnvelope({ callId: 'call-1', reason: 'timeout' });

  assert.equal(envelope.type, 'call.cancelled');
  assert.equal(envelope.ttlSeconds, 60);
  assert.equal(envelope.data.reason, 'timeout');
  // A missing reason still produces a well-formed envelope.
  assert.equal(buildCallCancelledEnvelope({ callId: 'call-1' }).data.reason, 'ended');
});

test('a message envelope truncates and collapses the preview', () => {
  const collapsed = buildMessageEnvelope({
    messageId: 'm-1',
    conversationId: 'alice:bob',
    senderId: 'alice',
    preview: '  hey   there\nyou  ',
  });
  assert.equal(collapsed.body, 'hey there you');
  assert.equal(collapsed.title, 'alice');

  const truncated = buildMessageEnvelope({
    messageId: 'm-2',
    conversationId: 'alice:bob',
    senderId: 'alice',
    preview: 'x'.repeat(200),
  });
  assert.equal(truncated.body.length, 120);
  assert.ok(truncated.body.endsWith('…'), 'a truncated preview is elided');

  const empty = buildMessageEnvelope({
    messageId: 'm-3',
    conversationId: 'alice:bob',
    senderId: 'alice',
    preview: null,
  });
  assert.equal(empty.body, 'Sent you a message');
});

// ─── Outcome classification ───────────────────────────────────────────────────

test('only transient failures are retryable', () => {
  // No status at all means the request never got a response: a network error.
  assert.equal(isRetryable(undefined), true);
  assert.equal(isRetryable({}), true);
  assert.equal(isRetryable({ statusCode: 429 }), true);
  assert.equal(isRetryable({ statusCode: 500 }), true);
  assert.equal(isRetryable({ statusCode: 503 }), true);

  // A rejected payload or a dead token will be rejected again next time.
  assert.equal(isRetryable({ statusCode: 400 }), false);
  assert.equal(isRetryable({ statusCode: 403 }), false);
  assert.equal(isRetryable({ statusCode: 404 }), false);
});

test('a dead token needs both a matching status and a matching reason', () => {
  assert.equal(isDeadTokenResult({ ok: false, statusCode: 404, reason: 'UNREGISTERED' }), true);
  assert.equal(isDeadTokenResult({ ok: false, statusCode: 400, reason: 'INVALID_ARGUMENT' }), true);
  assert.equal(isDeadTokenResult({ ok: false, statusCode: 400, reason: 'BadDeviceToken' }), true);
  assert.equal(
    isDeadTokenResult({ ok: false, statusCode: 404, reason: 'Invalid registration token' }),
    true
  );

  // A successful send never prunes a device, whatever it says.
  assert.equal(isDeadTokenResult({ ok: true, statusCode: 200, reason: 'UNREGISTERED' }), false);
  // Nor does a transient failure that happens to carry no status…
  assert.equal(isDeadTokenResult({ ok: false, reason: 'UNREGISTERED' }), false);
  // …a status that cannot mean a dead token…
  assert.equal(isDeadTokenResult({ ok: false, statusCode: 503, reason: 'UNREGISTERED' }), false);
  // …or one of the codes with an unrelated reason.
  assert.equal(isDeadTokenResult({ ok: false, statusCode: 400, reason: 'QUOTA_EXCEEDED' }), false);
  assert.equal(isDeadTokenResult({ ok: false, statusCode: 404 }), false);
  assert.equal(isDeadTokenResult(null), false);
});

// ─── Notification Hubs plumbing ───────────────────────────────────────────────

test('only x-ms-* response headers are kept, lower-cased', () => {
  const headers = extractNotificationHubCorrelationHeaders({
    'X-Ms-Request-Id': 'req-1',
    'x-ms-correlation-request-id': ['a', 'b'],
    'Content-Type': 'application/json',
    'x-ms-empty': undefined,
  });

  assert.deepEqual(headers, {
    'x-ms-request-id': 'req-1',
    'x-ms-correlation-request-id': 'a,b',
    'x-ms-empty': '',
  });
  assert.deepEqual(extractNotificationHubCorrelationHeaders(), {});
});

test('a hub connection string parses into an HTTPS endpoint and key', () => {
  const parsed = parseNotificationHubConnectionString(
    'Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Full;SharedAccessKey=secret='
  );

  assert.deepEqual(parsed, {
    endpoint: 'https://ns.servicebus.windows.net/',
    keyName: 'Full',
    // The key is base64 and may itself contain `=`, so only the first one splits.
    key: 'secret=',
  });
});

test('an unusable hub connection string parses to null rather than throwing', () => {
  assert.equal(parseNotificationHubConnectionString(''), null);
  assert.equal(
    parseNotificationHubConnectionString('SharedAccessKeyName=Full;SharedAccessKey=secret'),
    null,
    'no endpoint'
  );
  assert.equal(
    parseNotificationHubConnectionString('Endpoint=sb://ns/;SharedAccessKeyName=Full'),
    null,
    'no key'
  );
  assert.equal(
    parseNotificationHubConnectionString('Endpoint=amqp://ns/;SharedAccessKeyName=n;SharedAccessKey=k'),
    null,
    'an endpoint that is not addressable over HTTPS'
  );
});
