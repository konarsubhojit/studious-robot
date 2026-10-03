/** Resolve a public-facing name without changing the identifier used for routing. */
export function resolveDisplayName(userId: string, displayName?: string | null): string {
  return displayName?.trim() || userId;
}
