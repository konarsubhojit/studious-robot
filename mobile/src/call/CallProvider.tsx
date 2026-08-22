// @ts-check
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

export type CallFlow = ReturnType<typeof useCallFlow>;
export type AppSettings = ReturnType<typeof useAppSettings>;
export type PipView = ReturnType<typeof usePictureInPicturePip>;
export type CallInitiation = ReturnType<typeof useCallInitiation>;

export type CallContextValue = { callFlow: CallFlow; settings: AppSettings['settings']; isSettingsPanelVisible: AppSettings['isSettingsVisible']; setIsSettingsPanelVisible: AppSettings['setIsSettingsVisible']; handleAutoLightingToggle: AppSettings['handleAutoLightingToggle']; handleSpeakerDefaultToggle: AppSettings['handleSpeakerDefaultToggle']; handleDeveloperModeToggle: AppSettings['handleDeveloperModeToggle']; callState: CallFlow['callPhase']; isCallActive: boolean; isCallConnected: boolean; isCompact: CallFlow['isCompactView']; participantLabel: string | null; streams: ReturnType<typeof deriveCallStreams>; isCallMinimized: boolean; isBubbleDismissed: boolean; dismissBubble: () => void; minimizeCall: () => void; expandCall: () => void; minimizeCallOnNavigate: () => void; handleCallStageLayout: PipView['handleCallStageLayout']; pipGesture: PipView['pipGesture']; animatedPipStyle: PipView['animatedPipStyle']; startVideoCallWith: CallInitiation['startVideoCallWith']; startAudioCallWith: CallInitiation['startAudioCallWith']; endCall: () => void; handleExportLogs: () => Promise<void>; };

const CallContext = createContext((null as CallContextValue | null));

/**
 * The app's single source of truth for calls.
 *
 * It owns the server-authoritative call flow (`useCallFlow`, whose lifecycle is
 * driven by the state machine in `callStateMachine`) together with the
 * presentation concerns that hang off it — minimize/restore, the draggable
 * picture-in-picture self-view, call initiation and the derived stream pair —
 * and publishes them as one context so screens never have to pick between
 * competing call sources (the legacy room-join flow has been retired).
 *
 * @param {{ children: import('react').ReactNode }} props
 */
export function CallProvider({ children }: { children: import('react').ReactNode; }) {
  // Settings are loaded before the call flow because they influence call setup
  // (speaker-on-join). Status messages they raise are forwarded to the call
  // flow's status banner through a ref, since it is created below.
  /** @type {import('react').MutableRefObject<CallFlow['updateStatus'] | null>} */
  const updateStatusRef: import('react').MutableRefObject<CallFlow['updateStatus'] | null> = useRef(null);
  /** @type {CallFlow['updateStatus']} */
  const notifyStatus: CallFlow['updateStatus'] = useCallback((message, severity) => {
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

  const { isCallMinimized, setIsCallMinimized, isBubbleDismissed, dismissBubble } =
    useCallMinimize(isCallConnected);

  // Whenever the machine leaves an active state (the call ended, from either
  // side), drop the minimized flag so the next call never opens as a bubble.
  useEffect(() => {
    if (!isCallActive) {
      setIsCallMinimized(false);
    }
  }, [isCallActive, setIsCallMinimized]);

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
      // Device preferences (see `useAppSettings`)
      settings: appSettings.settings,
      isSettingsPanelVisible: appSettings.isSettingsVisible,
      setIsSettingsPanelVisible: appSettings.setIsSettingsVisible,
      handleAutoLightingToggle: appSettings.handleAutoLightingToggle,
      handleSpeakerDefaultToggle: appSettings.handleSpeakerDefaultToggle,
      handleDeveloperModeToggle: appSettings.handleDeveloperModeToggle,
      // Unified call state machine view
      callState,
      isCallActive,
      isCallConnected,
      isCompact: callFlow.isCompactView,
      participantLabel,
      streams,
      // Minimize / restore
      isCallMinimized,
      isBubbleDismissed,
      dismissBubble,
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
      dismissBubble,
      handleExportLogs,
      isBubbleDismissed,
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
 * @returns {CallContextValue} the value published by {@link CallProvider}
 */
export function useCall(): CallContextValue {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return context;
}
