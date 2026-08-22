export type MediaStreamTrackLike = { kind: string; enabled: boolean; };
export type MediaStreamLike = { getTracks: () => MediaStreamTrackLike[]; };

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

export function isTrackEnabled(stream: MediaStreamLike | null | undefined, kind: string): boolean {
  if (!stream?.getTracks) {
    return false;
  }

  const track = stream.getTracks().find(candidate => candidate.kind === kind);
  return Boolean(track?.enabled);
}
