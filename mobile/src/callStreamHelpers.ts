import { getStreamUrl } from './diagnostics';

/**
 * Derive the main/picture-in-picture stream pair (plus their playable URLs
 * and mirroring flags) for an active call, given which side is "primary"
 * (i.e. shown large).
 *
 * Kept out of the components so the derivation from the call state
 * (`localStream`, `remoteStream`, `isLocalPrimary`, `isFrontCamera`) has a
 * single, testable home; `CallProvider` publishes its result.
 *
 * @param params
 */
export function deriveCallStreams({
  isLocalPrimary,
  localStream,
  remoteStream,
  isFrontCamera,
  mainLabel,
  pipLabel,
}: {
        isLocalPrimary: boolean;
        localStream: unknown;
        remoteStream: unknown;
        isFrontCamera: boolean;
        mainLabel: string;
        pipLabel: string;
    }): {
    mainStream: unknown;
    pipStream: unknown;
    mainStreamUrl: string | null;
    pipStreamUrl: string | null;
    mirrorPip: boolean;
    mirrorMain: boolean;
    mainHasVideo: boolean;
} {
  const mainStream = isLocalPrimary ? localStream : remoteStream;
  const pipStream = isLocalPrimary ? remoteStream : localStream;

  return {
    mainStream,
    pipStream,
    mainStreamUrl: getStreamUrl(mainStream, mainLabel),
    pipStreamUrl: getStreamUrl(pipStream, pipLabel),
    mirrorPip: !isLocalPrimary && isFrontCamera,
    mirrorMain: isLocalPrimary && isFrontCamera,
    mainHasVideo: hasVideoTrack(mainStream),
  };
}

/**
 * Whether a stream would actually draw something on the video stage.
 *
 * An audio call still produces a `MediaStream` with a playable URL, so
 * "is there a stream" cannot answer "is there a picture" — asking it that way
 * is why an audio call used to render as a black rectangle with the peer's
 * video view stretched over it. A stream from a peer whose camera is off, or
 * from an audio-only call, has no video track.
 */
function hasVideoTrack(stream: unknown): boolean {
  const getVideoTracks = (stream as { getVideoTracks?: () => unknown[] } | null)?.getVideoTracks;
  if (typeof getVideoTracks !== 'function') return false;
  try {
    return (getVideoTracks.call(stream) ?? []).length > 0;
  } catch {
    return false;
  }
}
