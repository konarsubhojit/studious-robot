import test from 'node:test';
import assert from 'node:assert/strict';
import { callQualitySamples } from '../db/schema.ts';
import { getCallQualityMetrics, persistCallQualitySample } from '../src/callQuality.ts';
import type { Database } from '../db/client.ts';

const sample = {
  callId: '00000000-0000-4000-8000-000000000001',
  rttMs: 80,
  jitterMs: 12,
  packetLossPercent: 0.5,
  bitrateBps: 48_000,
  codec: 'opus',
};

test('call-quality samples persist each validated metric against their call', async () => {
  let inserted: { table: unknown; values: unknown; } | null = null;
  const db = {
    insert(table: unknown) {
      return {
        values(values: unknown) {
          inserted = { table, values };
          return { execute: async () => undefined };
        },
      };
    },
  } as unknown as Database;

  await persistCallQualitySample(db, sample);
  assert.deepEqual(inserted, { table: callQualitySamples, values: sample });
});

test('call-quality metrics are empty when Postgres is not configured', async () => {
  assert.deepEqual(await getCallQualityMetrics(null), {
    fleet: {
      samples: 0,
      rttP50: null,
      rttP95: null,
      jitterP50: null,
      jitterP95: null,
      packetLossP50: null,
      packetLossP95: null,
      bitrateP50: null,
      bitrateP95: null,
      excellent: 0,
      good: 0,
      fair: 0,
      poor: 0,
    },
    perCall: [],
    mosBuckets: { excellent: 0, good: 0, fair: 0, poor: 0 },
  });
});

test('call-quality metrics expose fleet and per-call percentile aggregates', async () => {
  const fleet = {
    samples: 2,
    rttP50: 90,
    rttP95: 99,
    jitterP50: 13,
    jitterP95: 14,
    packetLossP50: 0.6,
    packetLossP95: 0.7,
    bitrateP50: 49_000,
    bitrateP95: 50_000,
    excellent: 1,
    good: 1,
    fair: 0,
    poor: 0,
  };
  const perCall = { callId: sample.callId, ...fleet };
  const db = {
    select() {
      return {
        from() {
          const query = Promise.resolve([fleet]) as Promise<unknown[]> & {
            groupBy: () => Promise<unknown[]>;
          };
          query.groupBy = () => Promise.resolve([perCall]);
          return query;
        },
      };
    },
  } as unknown as Database;

  assert.deepEqual(await getCallQualityMetrics(db), {
    fleet,
    perCall: [perCall],
    mosBuckets: { excellent: 1, good: 1, fair: 0, poor: 0 },
  });
});
