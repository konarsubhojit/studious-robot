import { useCallback, useState } from 'react';
import { logVerbose } from '../appLogger';
import type { CallDelivery, CallEndSummary } from '../call/callDecisions';
import type { CallRecoveryStatus } from '../call/recoveryEpisode';
import type { CallStatus } from '../components/StatusBanner';

/**
 * Presentation state shared by the call screen, banners and timeline.
 *
 * The call orchestrator still decides when to publish or reset these values;
 * this hook owns no lifecycle transitions, media resources or recovery timers.
 */
export default function useCallPresentation() {
  const [status, setStatus] = useState({ message: '', severity: 'info' } as CallStatus);
  // Summary of the last connected call, surfaced by the conversation timeline.
  const [callSummary, setCallSummary] = useState(null as CallEndSummary | null);

  // True while the remote participant is screen-sharing (relayed via the
  // `call.media-state` socket event).
  const [isRemoteScreenSharing, setIsRemoteScreenSharing] = useState(false);
  // Whether the remote participant's camera is on, relayed over the same
  // event. Defaults to `true` because that is what an older peer — one that
  // never sends the flag — effectively claims, and because a video call starts
  // with both cameras live. `track.enabled = false` neither removes the track
  // nor tells the peer anything, so this relay is the only way the receiving
  // side can distinguish "a picture" from "a black rectangle".
  const [isRemoteVideoEnabled, setIsRemoteVideoEnabled] = useState(true);
  const [isLocalPrimary, setIsLocalPrimary] = useState(false);
  /**
   * Epoch milliseconds at which the current call connected, or `null`.
   *
   * Publishing a timestamp instead of a ticking `elapsedCallSeconds` keeps
   * elapsed-time updates out of the shared call/chat snapshot. Components that
   * show a duration derive it locally with `useCallElapsedSeconds`.
   */
  const [callConnectedAtMs, setCallConnectedAtMs] = useState(null as number | null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  // Non-null while a recovery episode is open, so the call screen can show what
  // is happening (and how much budget is left) instead of a static spinner.
  const [recoveryStatus, setRecoveryStatus] = useState(null as CallRecoveryStatus | null);
  // True from the moment the recovery budget is spent with media still down,
  // until the call is torn down. The ladder ending used to be invisible: the
  // banner vanished with the episode and the call simply stopped.
  const [isConnectionLost, setIsConnectionLost] = useState(false);
  // How the callee is being reached for an outgoing call: a device that can
  // ring now, or one a push still has to wake. Null until the server says.
  const [callDelivery, setCallDelivery] = useState(null as CallDelivery | null);

  const updateStatus: (message: string, severity?: CallStatus['severity']) => void = useCallback(
    (message, severity = 'info') => {
      logVerbose('[CallFlow] Status updated', { message, severity });
      setStatus({ message, severity });
    },
    [],
  );

  const dismissCallSummary = useCallback(() => {
    setCallSummary(null);
  }, []);

  return {
    status,
    updateStatus,
    callSummary,
    setCallSummary,
    dismissCallSummary,
    isRemoteScreenSharing,
    setIsRemoteScreenSharing,
    isRemoteVideoEnabled,
    setIsRemoteVideoEnabled,
    isLocalPrimary,
    setIsLocalPrimary,
    callConnectedAtMs,
    setCallConnectedAtMs,
    isReconnecting,
    setIsReconnecting,
    recoveryStatus,
    setRecoveryStatus,
    isConnectionLost,
    setIsConnectionLost,
    callDelivery,
    setCallDelivery,
  };
}
