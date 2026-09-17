import { useCallback } from 'react';
import { logError } from '../appLogger';

/**
 * Owns starting a call-flow call with a given peer and explicit media mode.
 *
 * Extracted out of `AppShell` so this concern is independently testable and
 * the component itself stays focused on screen routing / composition.
 *
 * @param params
 */
export default function useCallInitiation({ setCalleeId, placeCall, setOutgoingCallMediaType }: {
        isInCall: boolean;
        setCalleeId: (peerId: string) => void;
        placeCall: (peerId?: string, mediaType?: 'audio' | 'video') => Promise<void>;
        handleVideoToggle: () => void;
        setOutgoingCallMediaType: (mediaType: 'audio' | 'video') => void;
    }) {
  /**
   * Start a video call with `peerId` (used by the call log's redial action, the
   * People picker and the Chats tab's video-call header button).
   */
  const startVideoCallWith = useCallback(
    (peerId: string) => {
      setOutgoingCallMediaType('video');
      setCalleeId(peerId);
      placeCall(peerId, 'video').catch(error => {
        logError('placeCall (video) failed', error);
      });
    },
    [setCalleeId, placeCall, setOutgoingCallMediaType],
  );

  /**
   * Start an audio call without ever acquiring a camera track.
   */
  const startAudioCallWith = useCallback(
    (peerId: string) => {
      setOutgoingCallMediaType('audio');
      setCalleeId(peerId);
      placeCall(peerId, 'audio').catch(error => {
        logError('placeCall (audio) failed', error);
      });
    },
    [setCalleeId, placeCall, setOutgoingCallMediaType],
  );

  return { startVideoCallWith, startAudioCallWith };
}
