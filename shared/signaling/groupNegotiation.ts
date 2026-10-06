/**
 * Pair identity includes both admission epochs, so rejoining the same room
 * cannot reuse SDP or ICE from the previous pair session.
 */
export function groupNegotiationId(
  participants: ReadonlyArray<{ userId: string; acceptedAt?: string | null }>,
  firstUserId: string,
  secondUserId: string,
): string {
  return JSON.stringify([firstUserId, secondUserId].sort().map(userId => [
    userId, participants.find(person => person.userId === userId)?.acceptedAt ?? null,
  ]));
}
