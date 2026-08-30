import { normaliseId } from '../../lib/normalize.ts';

type JoinRoomDecision =
  | { action: 'ignore'; }
  | { action: 'room_full'; }
  | { action: 'join'; leaveRoomId: string | null; };

function decideRoomJoin({
  sessionId,
  roomId,
  currentRoom,
  roomSize,
  maxRoomSize,
}: {
  sessionId: string | null;
  roomId: unknown;
  currentRoom: string | null;
  roomSize: number;
  maxRoomSize: number;
}): JoinRoomDecision {
  if (!sessionId) return { action: 'ignore' };
  if (typeof roomId !== 'string' || roomId.length === 0) return { action: 'ignore' };
  if (roomSize >= maxRoomSize) return { action: 'room_full' };
  return { action: 'join', leaveRoomId: currentRoom };
}

function normalizeReportedActiveCallIds(parsed: Record<string, any>): string[] {
  const reported = Array.isArray(parsed.activeCallIds) ? parsed.activeCallIds : [parsed.callId];
  return reported.map((value: unknown) => normaliseId(value)).filter(Boolean) as string[];
}

export {
  decideRoomJoin,
  normalizeReportedActiveCallIds,
};
