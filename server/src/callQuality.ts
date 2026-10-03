import { sql } from 'drizzle-orm';
import { callQualitySamples } from '../db/schema.ts';
import type { Database } from '../db/client.ts';

type CallQualitySample = {
  callId: string;
  rttMs: number;
  jitterMs: number;
  packetLossPercent: number;
  bitrateBps: number;
  codec: string;
};

type QualityAggregate = {
  samples: number;
  rttP50: number | null;
  rttP95: number | null;
  jitterP50: number | null;
  jitterP95: number | null;
  packetLossP50: number | null;
  packetLossP95: number | null;
  bitrateP50: number | null;
  bitrateP95: number | null;
  excellent: number;
  good: number;
  fair: number;
  poor: number;
};

const EMPTY_AGGREGATE: QualityAggregate = {
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
};

function mosScoreSql() {
  const rFactor = sql`GREATEST(0, 93.2 - GREATEST(0, ${callQualitySamples.rttMs} / 2 + ${callQualitySamples.jitterMs} - 100) * 0.024 - ${callQualitySamples.packetLossPercent} * 2.5)`;
  return sql`LEAST(4.5, GREATEST(1.0, 1 + 0.035 * (${rFactor}) + (${rFactor}) * ((${rFactor}) - 60) * (100 - (${rFactor})) * 0.000007))`;
}

function qualitySelection() {
  const mos = mosScoreSql();
  return {
    samples: sql<number>`count(*)::int`,
    rttP50: sql<number | null>`percentile_cont(0.50) within group (order by ${callQualitySamples.rttMs})`,
    rttP95: sql<number | null>`percentile_cont(0.95) within group (order by ${callQualitySamples.rttMs})`,
    jitterP50: sql<number | null>`percentile_cont(0.50) within group (order by ${callQualitySamples.jitterMs})`,
    jitterP95: sql<number | null>`percentile_cont(0.95) within group (order by ${callQualitySamples.jitterMs})`,
    packetLossP50: sql<number | null>`percentile_cont(0.50) within group (order by ${callQualitySamples.packetLossPercent})`,
    packetLossP95: sql<number | null>`percentile_cont(0.95) within group (order by ${callQualitySamples.packetLossPercent})`,
    bitrateP50: sql<number | null>`percentile_cont(0.50) within group (order by ${callQualitySamples.bitrateBps})`,
    bitrateP95: sql<number | null>`percentile_cont(0.95) within group (order by ${callQualitySamples.bitrateBps})`,
    excellent: sql<number>`count(*) filter (where ${mos} >= 4.3)::int`,
    good: sql<number>`count(*) filter (where ${mos} >= 4.0 and ${mos} < 4.3)::int`,
    fair: sql<number>`count(*) filter (where ${mos} >= 3.6 and ${mos} < 4.0)::int`,
    poor: sql<number>`count(*) filter (where ${mos} < 3.6)::int`,
  };
}

async function persistCallQualitySample(db: Database | null, sample: CallQualitySample): Promise<void> {
  if (!db) return;
  await db.insert(callQualitySamples).values(sample).execute();
}

async function getCallQualityMetrics(db: Database | null) {
  if (!db) {
    return {
      fleet: EMPTY_AGGREGATE,
      perCall: [],
      mosBuckets: { excellent: 0, good: 0, fair: 0, poor: 0 },
    };
  }

  const [fleetRows, callRows] = await Promise.all([
    db.select(qualitySelection()).from(callQualitySamples),
    db
      .select({ callId: callQualitySamples.callId, ...qualitySelection() })
      .from(callQualitySamples)
      .groupBy(callQualitySamples.callId),
  ]);
  const fleet = fleetRows[0] ?? EMPTY_AGGREGATE;
  return {
    fleet,
    perCall: callRows,
    mosBuckets: {
      excellent: fleet.excellent,
      good: fleet.good,
      fair: fleet.fair,
      poor: fleet.poor,
    },
  };
}

export { getCallQualityMetrics, persistCallQualitySample };
export type { CallQualitySample };
