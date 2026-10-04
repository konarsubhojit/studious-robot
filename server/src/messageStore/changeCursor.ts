// Both memory stores share a sequence, just as the durable change logs do.
let sequence = 0n;

export function nextMessageChangeId(): string {
  return String(++sequence);
}

export function compareMessageChanges(
  a: { changedAt: string; changeId: string },
  b: { changedAt: string; changeId: string }
): number {
  return a.changedAt.localeCompare(b.changedAt) ||
    (BigInt(a.changeId) < BigInt(b.changeId) ? -1 : BigInt(a.changeId) > BigInt(b.changeId) ? 1 : 0);
}
