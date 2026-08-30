import { SERVER_EVENTS } from '../../../../shared/index.ts';
import { endCallsForDisconnectedParticipant } from '../../domain/calls.ts';
import { notifyCallTransition } from '../../domain/notifications.ts';

function leaveRoom(
  socket: import('socket.io').Socket,
  roomId: string,
  rooms: Map<string, Set<string>>
) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(socket.id);
  void socket.leave(roomId);
  console.log(`[signaling] leave: socket ${socket.id} left room "${roomId}" (size=${room.size})`);

  if (room.size === 0) {
    rooms.delete(roomId);
  } else {
    socket.to(roomId).emit(SERVER_EVENTS.PEER_LEFT, { id: socket.id });
  }
}

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
  leaveRoom,
  logCallCorrelation,
  scheduleParticipantDisconnectCleanup,
};
