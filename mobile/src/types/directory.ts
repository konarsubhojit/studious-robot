import type { ConversationSummary } from '../hooks/useMessaging';

/**
 * Presence snapshot for a peer, as returned by the directory endpoint.
 *
 * "Not fetched yet" is modelled by the *absence* of a snapshot (`null`), never
 * by a missing `online`, so `presence.online === false` reliably means offline.
 * `unknown` marks a peer the server has never heard of (a 404), which reads
 * differently from a peer that is merely offline.
 */
export type PeerPresence = {
  status?: string;
  online: boolean;
  unknown?: boolean;
};

/** Contact returned by the server-side user search. */
export type ContactRow = { userId: string; online?: boolean };

/** Conversation row, as held by the chat provider. */
export type ConversationRow = ConversationSummary & { online?: boolean };
