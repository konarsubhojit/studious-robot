import test from 'node:test';
import assert from 'node:assert/strict';

import { createFirebaseTokenVerifier } from '../src/firebaseAuth.ts';

test('throws without FCM_SERVICE_ACCOUNT_JSON when the test-auth bypass is disabled', () => {
  assert.throws(() => createFirebaseTokenVerifier({ serviceAccountValue: undefined }));
});

test('does not throw without FCM_SERVICE_ACCOUNT_JSON when the test-auth bypass is enabled', () => {
  assert.doesNotThrow(() =>
    createFirebaseTokenVerifier({ serviceAccountValue: undefined, testAuthBypassEnabled: true }),
  );
});

test('bypasses verification for a prefixed test user id when enabled', async () => {
  const verify = createFirebaseTokenVerifier({
    serviceAccountValue: undefined,
    testAuthBypassEnabled: true,
  });

  const identity = await verify('lt-42');
  assert.equal(identity.authUid, 'lt-42');
  assert.equal(identity.authProvider, 'test');
});

test('rejects an unprefixed token even when the bypass is enabled and no verifier is configured', async () => {
  const verify = createFirebaseTokenVerifier({
    serviceAccountValue: undefined,
    testAuthBypassEnabled: true,
  });

  await assert.rejects(() => verify('some-real-firebase-id-token'));
});

test('honours a custom test-user prefix', async () => {
  const verify = createFirebaseTokenVerifier({
    serviceAccountValue: undefined,
    testAuthBypassEnabled: true,
    testAuthUserPrefix: 'loadtest-',
  });

  const identity = await verify('loadtest-7');
  assert.equal(identity.authUid, 'loadtest-7');
  await assert.rejects(() => verify('lt-7'));
});
