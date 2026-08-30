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
  localVideoEnabled = true,
  remoteVideoEnabled = true,
  mainLabel,
  pipLabel,
}: {
        isLocalPrimary: boolean;
        localStream: unknown;
        remoteStream: unknown;
        isFrontCamera: boolean;
        localVideoEnabled?: boolean;
        remoteVideoEnabled?: boolean;
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
    pipHasVideo: boolean;
} {
  const mainStream = isLocalPrimary ? localStream : remoteStream;
  const pipStream = isLocalPrimary ? remoteStream : localStream;
  const mainCameraOn = isLocalPrimary ? localVideoEnabled : remoteVideoEnabled;
  const pipCameraOn = isLocalPrimary ? remoteVideoEnabled : localVideoEnabled;

  return {
    mainStream,
    pipStream,
    mainStreamUrl: getStreamUrl(mainStream, mainLabel),
    pipStreamUrl: getStreamUrl(pipStream, pipLabel),
    mirrorPip: !isLocalPrimary && isFrontCamera,
    mirrorMain: isLocalPrimary && isFrontCamera,
    mainHasVideo: streamHasPicture(mainStream, mainCameraOn),
    pipHasVideo: streamHasPicture(pipStream, pipCameraOn),
  };
}

/**
 * Whether a stream would actually draw something on the video stage.
 *
 * Two independent things have to be true, and asking only the first is the bug
 * this function exists to hold closed.
 *
 * A stream has to *have* a video track: an audio call still produces a
 * `MediaStream` with a playable URL, so "is there a stream" cannot answer "is
 * there a picture" — asking it that way is why an audio call used to render as
 * a black rectangle with the peer's video view stretched over it.
 *
 * But the track also has to be sending frames, and a camera that has been
 * turned off does **not** remove its track — `setTrackEnabled` only sets
 * `track.enabled = false`, and a disabled sender keeps transmitting (black)
 * frames, so the receiver still sees a track. `enabled` is a purely local flag
 * the peer cannot observe, which is why each side relays its camera state over
 * `call.media-state` and it arrives here as `cameraOn`.
 *
 * @param stream - The `MediaStream` shown in this tile, if any.
 * @param cameraOn - Whether the stream's owner says its camera is on. Defaults
 *   to `true` for a peer that never sent the flag, so an older client is
 *   treated exactly as it was before camera state was relayed.
 */
function streamHasPicture(stream: unknown, cameraOn: boolean): boolean {
  return cameraOn && hasVideoTrack(stream);
}

/**
 * Whether a stream carries a video track at all.
 *
 * Tolerates a missing or throwing `getVideoTracks`, because the value comes
 * from a native object whose shape this module does not control.
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
