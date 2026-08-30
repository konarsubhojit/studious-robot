import { SIGNALING_VERSION } from '../../config.ts';
import { emitToUserSockets } from '../../domain/notifications.ts';
import { resolveOfflinePushChannels } from '../../lib/state.ts';
import { pruneDeadDevice } from '../../lib/persistence.ts';
import { pushSenders } from '../../push.ts';
import { describeError } from '../../lib/errors.ts';
import { describeMessagePreview, SERVER_EVENTS } from '../../../../shared/index.ts';

function deliverMessage(
  io: import('socket.io').Server,
  state: import('../../stores/contracts.ts').ServerState,
  message: import('../../stores/contracts.ts').MessageRecord
) {
  const envelope = {
    version: SIGNALING_VERSION,
    conversationId: message.conversationId,
    message,
  };
  emitToUserSockets(io, message.recipientId, SERVER_EVENTS.MESSAGE_RECEIVED, envelope);

  const pushChannels = resolveOfflinePushChannels(state, message.recipientId);
  for (const channel of pushChannels) {
    pushSenders
      .sendMessagePush(channel, {
        messageId: message.messageId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        preview: describeMessagePreview(message),
      })
      .then((outcome) => {
        if (!outcome?.deadToken) return;
        return pruneDeadDevice(state.db, state, outcome.deviceId, outcome.reason ?? 'unknown');
      })
      .catch((error) => {
        console.error(
          `[messages] Unhandled push error for device ${channel.deviceId}: ${describeError(error)}`
        );
      });
  }
}

export { deliverMessage };
