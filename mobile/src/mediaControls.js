export function setTrackEnabled(stream, kind, enabled) {
  if (!stream?.getTracks) {
    return false;
  }

  const tracks = stream.getTracks().filter((track) => track.kind === kind);
  tracks.forEach((track) => {
    track.enabled = enabled;
  });

  return tracks.length > 0;
}

export function isTrackEnabled(stream, kind) {
  if (!stream?.getTracks) {
    return false;
  }

  const track = stream.getTracks().find((candidate) => candidate.kind === kind);
  return Boolean(track?.enabled);
}
