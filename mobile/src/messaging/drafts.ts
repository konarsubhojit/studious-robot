import type { ChatDraft } from '../storage/chatDb';

/**
 * Per-conversation drafts.
 *
 * A draft is the composer text (and reply target) the user typed but did not
 * send. It is held per peer rather than in the composer's own state so it
 * survives switching conversations, backgrounding and process death — the
 * drafts map is part of the persisted chat snapshot.
 */

export type Drafts = Record<string, ChatDraft>;

/**
 * Record (or clear) the unsent composer entry for a conversation.
 *
 * Empty text removes the draft outright, so an emptied composer does not leave
 * a phantom "draft" marker in the conversation list. An unchanged draft returns
 * the map it was given, so re-saving identical text does not re-render the
 * chat list or re-arm the snapshot write.
 */
export function withDraft(
  drafts: Drafts,
  peerId: string,
  text: string,
  replyToId: string | null = null,
  now: () => string = () => new Date().toISOString(),
): Drafts {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) return withoutDraft(drafts, peerId);
  const existing = drafts[peerId];
  if (existing?.text === value && (existing.replyToId ?? null) === (replyToId ?? null)) {
    return drafts;
  }
  return {
    ...drafts,
    [peerId]: { text: value, replyToId: replyToId ?? null, updatedAt: now() },
  };
}

/** Drop the draft for a conversation (on send, or when it is emptied). */
export function withoutDraft(drafts: Drafts, peerId: string): Drafts {
  if (!drafts[peerId]) return drafts;
  const next = { ...drafts };
  delete next[peerId];
  return next;
}
