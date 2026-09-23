import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseReportedActiveCallIds } from '../src/signaling/connection/state.ts';

test('normaliseReportedActiveCallIds preserves reconciliation semantics', () => {
  assert.deepEqual(
    normaliseReportedActiveCallIds({ activeCallIds: ['abc', ' ', null, 'def'] }),
    ['abc', 'def']
  );
  assert.deepEqual(
    normaliseReportedActiveCallIds({ callId: 'xyz' }),
    ['xyz']
  );
});
