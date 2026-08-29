export type MediaStreamTrackLike = { kind: string; enabled: boolean; };
export type MediaStreamLike = { getTracks: () => MediaStreamTrackLike[]; };

/**
 * Enable or disable every track of `kind` on `stream`.
 *
 * @returns whether the tracks now actually carry `enabled`. A caller commits
 *   its UI state only on `true`: a mute button that lit up while the track
 *   kept publishing would tell the user the far end cannot hear them when it
 *   still can, which is the one failure mode this control must not have. A
 *   stream with no track of that kind, a setter that throws, and a track that
 *   silently refuses the change are therefore all reported the same way.
 */
export function setTrackEnabled(stream: MediaStreamLike | null | undefined, kind: string, enabled: boolean): boolean {
  if (!stream?.getTracks) {
    return false;
  }

  let tracks;
  try {
    tracks = stream.getTracks().filter(track => track.kind === kind);
  } catch {
    return false;
  }
  if (tracks.length === 0) {
    return false;
  }

  return tracks.every(track => {
    try {
      track.enabled = enabled;
    } catch {
      return false;
    }
    // Read back rather than trusting the write: the track object is a bridge
    // to a native sender, so the assignment can be a no-op.
    return track.enabled === enabled;
  });
}

export function isTrackEnabled(stream: MediaStreamLike | null | undefined, kind: string): boolean {
  if (!stream?.getTracks) {
    return false;
  }

  const track = stream.getTracks().find(candidate => candidate.kind === kind);
  return Boolean(track?.enabled);
}
