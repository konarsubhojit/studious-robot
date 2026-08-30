/**
 * Public facade for text-chat signaling handlers.
 *
 * The implementation lives in `signaling/messageHandlers/` and is split by
 * concern (validation, send flow, delivery, and event registration). Keeping
 * this file preserves existing import paths.
 */

export {
  registerMessageHandlers,
  deliverMessage,
  _validateBody,
  _validateReactionEmoji,
} from './messageHandlers/index.ts';
