import { normaliseId } from '../../lib/normalize.ts';

function normaliseReportedActiveCallIds(parsed: Record<string, any>): string[] {
  const reported = Array.isArray(parsed.activeCallIds) ? parsed.activeCallIds : [parsed.callId];
  return reported.map((value: unknown) => normaliseId(value)).filter(Boolean) as string[];
}

export {
  normaliseReportedActiveCallIds,
};
