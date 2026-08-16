import { getStreamUrl } from './diagnostics';

/**
 * Derive the main/picture-in-picture stream pair (plus their playable URLs
 * and mirroring flags) for an active call, given which side is "primary"
 * (i.e. shown large).
 *
 * Both `useCallFlow` and the legacy `useWebRTCCall` flow expose the same
 * shape (`localStream`, `remoteStream`, `isLocalPrimary`, `isFrontCamera`),
 * so `AppShell` previously duplicated this derivation once per flow — this
 * helper is the single source of truth for that logic (DRY).
 *
 * @param {{
 *   isLocalPrimary: boolean,
 *   localStream: unknown,
 *   remoteStream: unknown,
 *   isFrontCamera: boolean,
 *   mainLabel: string,
 *   pipLabel: string,
 * }} params
 * @returns {{
 *   mainStream: unknown,
 *   pipStream: unknown,
 *   mainStreamUrl: string | null,
 *   pipStreamUrl: string | null,
 *   mirrorPip: boolean,
 *   mirrorMain: boolean,
 * }}
 */
export function deriveCallStreams({
  isLocalPrimary,
  localStream,
  remoteStream,
  isFrontCamera,
  mainLabel,
  pipLabel,
}) {
  const mainStream = isLocalPrimary ? localStream : remoteStream;
  const pipStream = isLocalPrimary ? remoteStream : localStream;

  return {
    mainStream,
    pipStream,
    mainStreamUrl: getStreamUrl(mainStream, mainLabel),
    pipStreamUrl: getStreamUrl(pipStream, pipLabel),
    mirrorPip: !isLocalPrimary && isFrontCamera,
    mirrorMain: isLocalPrimary && isFrontCamera,
  };
}
