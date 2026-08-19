// @ts-check

/**
 * @typedef {{ kind: string, enabled: boolean }} MediaStreamTrackLike
 * @typedef {{ getTracks: () => MediaStreamTrackLike[] }} MediaStreamLike
 */

/**
 * @param {MediaStreamLike | null | undefined} stream
 * @param {string} kind
 * @param {boolean} enabled
 * @returns {boolean}
 */
export function setTrackEnabled(stream, kind, enabled) {
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
export function isTrackEnabled(stream, kind) {
  if (!stream?.getTracks) {
    return false;
  }

  const track = stream.getTracks().find(candidate => candidate.kind === kind);
  return Boolean(track?.enabled);
}
