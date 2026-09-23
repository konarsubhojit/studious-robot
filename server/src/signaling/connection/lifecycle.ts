import { endCallsForDisconnectedParticipant } from '../../domain/calls.ts';
import { notifyCallTransition } from '../../domain/notifications.ts';

function scheduleParticipantDisconnectCleanup(
  io: import('socket.io').Server,
  state: import('../../stores/contracts.ts').ServerState,
  userId: string | undefined,
  graceMs: number
) {
  if (!userId) return;
  const timer = setTimeout(() => {
    endCallsForDisconnectedParticipant(state, userId, {
      onTransition: (call, previousStatus, reason) =>
        notifyCallTransition(io, state, call, { previousStatus, actor: null, reason }),
    });
  }, graceMs);
  timer.unref?.();
}

function logCallCorrelation(socket: import('socket.io').Socket, callId: string, eventName: string) {
  const correlationId = socket.data.identity?.correlationId;
  if (!callId || !correlationId) return;
  console.log(
    `[signaling] call.correlation callId=${callId} correlationId=${correlationId}` +
      ` userId=${socket.data.identity.userId} event=${eventName}`
  );
}

export {
  logCallCorrelation,
  scheduleParticipantDisconnectCleanup,
};
