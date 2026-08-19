import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { deriveCallStreams } from '../callStreamHelpers';
import { exportDiagnosticLogs } from '../diagnostics';
import useAppSettings from '../hooks/useAppSettings';
import useCallFlow from '../hooks/useCallFlow';
import useCallInitiation from '../hooks/useCallInitiation';
import useCallMinimize from '../hooks/useCallMinimize';
import useCameraLighting from '../hooks/useCameraLighting';
import usePictureInPicturePip from '../hooks/usePictureInPicturePip';
import { CALL_STATES, isCallActiveState } from './callStateMachine';

const CallContext = createContext(null);

/**
 * The app's single source of truth for calls.
 *
 * It owns the server-authoritative call flow (`useCallFlow`, whose lifecycle is
 * driven by the state machine in `callStateMachine`) together with the
 * presentation concerns that hang off it — minimize/restore, the draggable
 * picture-in-picture self-view, call initiation and the derived stream pair —
 * and publishes them as one context so screens never have to pick between
 * competing call sources (the legacy room-join flow has been retired).
 */
export function CallProvider({ children }) {
  // Settings are loaded before the call flow because they influence call setup
  // (speaker-on-join). Status messages they raise are forwarded to the call
  // flow's status banner through a ref, since it is created below.
  const updateStatusRef = useRef(null);
  const notifyStatus = useCallback((message, severity) => {
    updateStatusRef.current?.(message, severity);
  }, []);
  const appSettings = useAppSettings({ onStatus: notifyStatus });

  const callFlow = useCallFlow({
    speakerEnabledByDefault: appSettings.settings.speakerEnabledByDefault,
  });
  useEffect(() => {
    updateStatusRef.current = callFlow.updateStatus;
  }, [callFlow.updateStatus]);

  useCameraLighting({
    localStream: callFlow.localStream,
    enabled: appSettings.settings.autoCameraLightingEnabled,
  });

  const callState = callFlow.callPhase;
  const isCallActive = isCallActiveState(callState);
  // Only a connected (post-ringing) call can be minimized; ringing screens
  // always take over the whole display.
  const isCallConnected = callState === CALL_STATES.IN_CALL;

  const { isCallMinimized, setIsCallMinimized } = useCallMinimize(isCallConnected);

  const { handleCallStageLayout, pipGesture, animatedPipStyle } = usePictureInPicturePip({
    onTap: callFlow.handleSwapStreams,
  });

  const { startVideoCallWith, startAudioCallWith } = useCallInitiation({
    isInCall: callFlow.isInCall,
    setCalleeId: callFlow.setCalleeId,
    placeCall: callFlow.placeCall,
    handleVideoToggle: callFlow.handleVideoToggle,
  });

  const streams = useMemo(
    () =>
      deriveCallStreams({
        isLocalPrimary: callFlow.isLocalPrimary,
        localStream: callFlow.localStream,
        remoteStream: callFlow.remoteStream,
        isFrontCamera: callFlow.isFrontCamera,
        mainLabel: 'main stream',
        pipLabel: 'picture-in-picture stream',
      }),
    [callFlow.isFrontCamera, callFlow.isLocalPrimary, callFlow.localStream, callFlow.remoteStream],
  );

  /**
   * Label for the remote party shown in the call top bar and the floating
   * bubble: the callee when the local user placed the call, the caller
   * otherwise.
   */
  const activeCall = callFlow.activeCall;
  const participantLabel = useMemo(() => {
    if (!activeCall?.callerId || !activeCall?.calleeId) return null;
    const remoteId = callFlow.isLocalPrimary ? activeCall.calleeId : activeCall.callerId;
    return `Call with ${remoteId}`;
  }, [activeCall, callFlow.isLocalPrimary]);

  const endCall = useCallback(() => {
    setIsCallMinimized(false);
    callFlow.handleEndCall();
  }, [callFlow, setIsCallMinimized]);

  const minimizeCall = useCallback(() => setIsCallMinimized(true), [setIsCallMinimized]);
  const expandCall = useCallback(() => setIsCallMinimized(false), [setIsCallMinimized]);

  // Tapping a bottom tab while a connected call is full-screen shrinks it to
  // the floating bubble rather than tearing the call down.
  const minimizeCallOnNavigate = useCallback(() => {
    if (isCallConnected && !isCallMinimized) {
      setIsCallMinimized(true);
    }
  }, [isCallConnected, isCallMinimized, setIsCallMinimized]);

  const handleExportLogs = useCallback(async () => {
    const result = await exportDiagnosticLogs({
      signalingUrl: callFlow.signalingUrl,
      callId: callFlow.activeCall?.callId ?? null,
      status: callFlow.status?.message,
      localStream: callFlow.localStream,
      remoteStream: callFlow.remoteStream,
      isInCall: callFlow.isInCall,
    });
    callFlow.updateStatus(result.message, result.ok ? 'success' : 'error');
  }, [callFlow]);

  const value = useMemo(
    () => ({
      callFlow,
      settings: appSettings,
      // Unified call state machine view
      callState,
      isCallActive,
      isCallConnected,
      isCompact: callFlow.isCompactView,
      participantLabel,
      streams,
      // Minimize / restore
      isCallMinimized,
      minimizeCall,
      expandCall,
      minimizeCallOnNavigate,
      // Picture-in-picture self view
      handleCallStageLayout,
      pipGesture,
      animatedPipStyle,
      // Actions
      startVideoCallWith,
      startAudioCallWith,
      endCall,
      handleExportLogs,
    }),
    [
      animatedPipStyle,
      appSettings,
      callFlow,
      callState,
      endCall,
      expandCall,
      handleCallStageLayout,
      handleExportLogs,
      isCallActive,
      isCallConnected,
      isCallMinimized,
      minimizeCall,
      minimizeCallOnNavigate,
      participantLabel,
      pipGesture,
      startAudioCallWith,
      startVideoCallWith,
      streams,
    ],
  );

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

/**
 * Access the single call context.
 *
 * @returns {object} the value published by {@link CallProvider}
 */
export function useCall() {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return context;
}
