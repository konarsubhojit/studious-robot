// @ts-check
import { useCallback, useEffect, useRef } from 'react';
import { logError } from '../appLogger';

/**
 * Owns starting a call-flow call with a given peer, for both the video and
 * "audio-only" (video call with the camera turned off once connected) cases.
 *
 * There is no dedicated audio-only call type server-side, so `startAudioCallWith`
 * places a normal video call and defers turning the camera off until the call
 * actually connects (`isInCall` flips true), tracked via `pendingAudioOnlyCallRef`.
 *
 * Extracted out of `AppShell` so this concern is independently testable and
 * the component itself stays focused on screen routing / composition.
 *
 * @param {{
 *   isInCall: boolean,
 *   setCalleeId: (peerId: string) => void,
 *   placeCall: (peerId?: string) => Promise<void>,
 *   handleVideoToggle: () => void,
 * }} params
 */
export default function useCallInitiation({ isInCall, setCalleeId, placeCall, handleVideoToggle }) {
  // Set by startAudioCallWith; consumed by the effect below once the call
  // connects, since there is no dedicated audio-only call type server-side.
  const pendingAudioOnlyCallRef = useRef(false);

  /**
   * Start a video call with `peerId` (used by both the Lobby redial action and
   * the Chats tab's video-call header button).
   */
  const startVideoCallWith = useCallback(
    (/** @type {string} */ peerId) => {
      setCalleeId(peerId);
      placeCall(peerId).catch(error => {
        logError('placeCall (video) failed', error);
      });
    },
    [setCalleeId, placeCall],
  );

  /**
   * Start an "audio call" with `peerId`: places a normal video call, then
   * turns the local camera off once it connects (see the effect below).
   */
  const startAudioCallWith = useCallback(
    (/** @type {string} */ peerId) => {
      pendingAudioOnlyCallRef.current = true;
      setCalleeId(peerId);
      placeCall(peerId).catch(error => {
        logError('placeCall (audio) failed', error);
      });
    },
    [setCalleeId, placeCall],
  );

  useEffect(() => {
    if (isInCall && pendingAudioOnlyCallRef.current) {
      pendingAudioOnlyCallRef.current = false;
      handleVideoToggle();
    }
  }, [isInCall, handleVideoToggle]);

  return { startVideoCallWith, startAudioCallWith };
}
