export type ParticipantGridLayout = {
  columns: number;
  rows: number;
};

/** Balanced tile geometry for the supported participant presentation range. */
export function getParticipantGridLayout(participantCount: number): ParticipantGridLayout {
  const count = Math.max(1, Math.floor(participantCount));
  const columns = count <= 2 ? count : Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

/** The visual ordering is stable except that the active speaker leads the grid. */
export function orderParticipantsBySpeaker<T extends { userId: string }>(
  participants: readonly T[],
  activeSpeakerId: string | null,
): T[] {
  if (!activeSpeakerId) return [...participants];
  return [...participants].sort((left, right) =>
    Number(right.userId === activeSpeakerId) - Number(left.userId === activeSpeakerId),
  );
}
