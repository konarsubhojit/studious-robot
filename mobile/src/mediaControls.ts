export type MediaStreamTrackLike = { kind: string; enabled: boolean; };
export type MediaStreamLike = { getTracks: () => MediaStreamTrackLike[]; };

/**
 * @param {MediaStreamLike | null | undefined} stream
 * @param {string} kind
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function setTrackEnabled(stream: MediaStreamLike | null | undefined, kind: string, enabled: boolean): boolean {
  if (!stream?.getTracks) {
    return false;
  }

  const tracks = stream.getTracks().filter(track => track.kind === kind);
  tracks.forEach(track => {
    track.enabled = enabled;
  });

  return tracks.length > 0;
}

/**
 * @param {MediaStreamLike | null | undefined} stream
 * @param {string} kind
 * @returns {boolean}
 */
export function isTrackEnabled(stream: MediaStreamLike | null | undefined, kind: string): boolean {
  if (!stream?.getTracks) {
    return false;
  }

  const track = stream.getTracks().find(candidate => candidate.kind === kind);
  return Boolean(track?.enabled);
}
