import type { ConversationSummary } from '../hooks/useMessaging';

/**
 * Presence snapshot for a peer, as returned by the directory endpoint.
 *
 * `online` is optional because a screen may render before presence has been
 * fetched; `unknown` marks a peer the server has never heard of (a 404), which
 * reads differently from a peer that is merely offline.
 */
export type PeerPresence = {
  status?: string;
  online?: boolean;
  unknown?: boolean;
};

/** Contact returned by the server-side user search. */
export type ContactRow = { userId: string; online?: boolean };

/** Conversation row, as held by the chat provider. */
export type ConversationRow = ConversationSummary & { online?: boolean };
