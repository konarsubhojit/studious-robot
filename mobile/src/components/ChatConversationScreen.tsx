/**
 * Public conversation-screen façade.
 *
 * Keeping this module at its established path preserves every consumer import
 * while the presentation implementation is maintained in the chat feature.
 */
export { default, findUnreadAnchorKey } from './chat/ChatConversationPresentation';
export type {
  AttachmentKind,
  CallActivity,
  ChatConversationScreenProps,
  ChatMessage,
  ChatStyles,
  ListItem,
  MessageAction,
  MessageRowProps,
  MessageStatus,
  PeerPresence,
  ReactionAction,
  ReactionChange,
  TimelineEntry,
} from './chat/ChatConversationPresentation';
