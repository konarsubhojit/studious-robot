import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { deriveCallStreams } from '../callStreamHelpers';
import { exportDiagnosticLogs } from '../diagnostics';
import useAppSettings from '../hooks/useAppSettings';
import useCallFlow from '../hooks/useCallFlow';
import useCallInitiation from '../hooks/useCallInitiation';
import useCallMinimize from '../hooks/useCallMinimize';
import useCameraLighting from '../hooks/useCameraLighting';
import usePictureInPicturePip from '../hooks/usePictureInPicturePip';
import { CALL_STATES, isCallActiveState } from './callStateMachine';
import type { MutableRefObject, ReactNode } from 'react';

export type CallFlow = ReturnType<typeof useCallFlow>;
export type AppSettings = ReturnType<typeof useAppSettings>;
export type PipView = ReturnType<typeof usePictureInPicturePip>;
export type CallInitiation = ReturnType<typeof useCallInitiation>;

export type CallContextValue = {
  callFlow: CallFlow;
  settings: AppSettings['settings'];
  handleAutoLightingToggle: AppSettings['handleAutoLightingToggle'];
  handleSpeakerDefaultToggle: AppSettings['handleSpeakerDefaultToggle'];
  handleDeveloperModeToggle: AppSettings['handleDeveloperModeToggle'];
  handleHapticsToggle: AppSettings['handleHapticsToggle'];
  handleIceTransportPolicyChange: AppSettings['handleIceTransportPolicyChange'];
  callState: CallFlow['callPhase'];
  isCallActive: boolean;
  isCallConnected: boolean;
  isCompact: CallFlow['isCompactView'];
  participantLabel: string | null;
  streams: ReturnType<typeof deriveCallStreams>;
  isCallMinimized: boolean;
  isBubbleDismissed: boolean;
  dismissBubble: () => void;
  minimizeCall: () => void;
  expandCall: () => void;
  minimizeCallOnNavigate: () => void;
  handleCallStageLayout: PipView['handleCallStageLayout'];
  handleTopChromeLayout: PipView['handleTopChromeLayout'];
  handleBottomChromeLayout: PipView['handleBottomChromeLayout'];
  pipGesture: PipView['pipGesture'];
  animatedPipStyle: PipView['animatedPipStyle'];
  startVideoCallWith: CallInitiation['startVideoCallWith'];
  startAudioCallWith: CallInitiation['startAudioCallWith'];
  endCall: () => void;
  handleExportLogs: () => Promise<void>;
};

/**
 * The published call snapshot, plus the subscription machinery that lets a
 * consumer wake up for one slice of it.
 *
 * The store object itself never changes identity, so putting it in a context
 * means the context never invalidates: a consumer re-renders only when the
 * slice it selected actually changed.
 */
export type CallStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => CallContextValue;
};

const CallStoreContext = createContext((null as CallStore | null));

/**
 * The app's single source of truth for calls.
 *
 * It owns the server-authoritative call flow (`useCallFlow`, whose lifecycle is
 * driven by the state machine in `callStateMachine`) together with the
 * presentation concerns that hang off it — minimize/restore, the draggable
 * picture-in-picture self-view, call initiation and the derived stream pair —
 * and publishes them as one snapshot so screens never have to pick between
 * competing call sources (the legacy room-join flow has been retired).
 *
 * The snapshot is published through a *store* rather than through the context
 * value itself. `useCallFlow` returns continuously-evolving state (timers,
 * connection stats, recovery attempts), so a context carrying that state
 * directly re-renders every consumer — including chat surfaces that read none
 * of it — several times a second. Consumers select the slice they read with
 * {@link useCallSelector} and are woken only when that slice changes.
 */
export function CallProvider({ children }: { children: ReactNode; }) {
  // Settings are loaded before the call flow because they influence call setup
  // (speaker-on-join). Status messages they raise are forwarded to the call
  // flow's status banner through a ref, since it is created below.
  const updateStatusRef: MutableRefObject<CallFlow['updateStatus'] | null> = useRef(null);
  const notifyStatus: CallFlow['updateStatus'] = useCallback((message, severity) => {
    updateStatusRef.current?.(message, severity);
  }, []);
  const appSettings = useAppSettings({ onStatus: notifyStatus });

  const callFlow = useCallFlow({
    speakerEnabledByDefault: appSettings.settings.speakerEnabledByDefault,
    iceTransportPolicy: appSettings.settings.iceTransportPolicy,
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

  const {
    handleCallStageLayout,
    handleTopChromeLayout,
    handleBottomChromeLayout,
    pipGesture,
    animatedPipStyle,
  } = usePictureInPicturePip({
    onTap: callFlow.handleSwapStreams,
  });

  const { startVideoCallWith, startAudioCallWith } = useCallInitiation({
    isInCall: callFlow.isInCall,
    setCalleeId: callFlow.setCalleeId,
    placeCall: callFlow.placeCall,
    handleVideoToggle: callFlow.handleVideoToggle,
    setOutgoingCallMediaType: callFlow.setOutgoingCallMediaType,
  });

  const streams = useMemo(
    () =>
      deriveCallStreams({
        isLocalPrimary: callFlow.isLocalPrimary,
        localStream: callFlow.localStream,
        remoteStream: callFlow.remoteStream,
        isFrontCamera: callFlow.isFrontCamera,
        localVideoEnabled: callFlow.isVideoEnabled,
        remoteVideoEnabled: callFlow.isRemoteVideoEnabled,
        mainLabel: 'main stream',
        pipLabel: 'picture-in-picture stream',
      }),
    [
      callFlow.isFrontCamera,
      callFlow.isLocalPrimary,
      callFlow.isRemoteVideoEnabled,
      callFlow.isVideoEnabled,
      callFlow.localStream,
      callFlow.remoteStream,
    ],
  );

  /**
   * Label for the remote party shown in the call top bar and the floating
   * bubble: the callee when the local user placed the call, the caller
   * otherwise.
   */
  const activeCall = callFlow.activeCall;
  const localUserId = callFlow.userId;
  const participantLabel = useMemo(() => {
    if (!activeCall?.callerId || !activeCall?.calleeId) return null;
    // Who the remote party is depends on which end of the call this device is,
    // never on `isLocalPrimary` — that flag only tracks which stream is
    // currently in the main tile, so tapping the self-view to swap streams used
    // to relabel the call with the local user's own id.
    const remoteId =
      activeCall.callerId === localUserId ? activeCall.calleeId : activeCall.callerId;
    return `Call with ${remoteId}`;
  }, [activeCall, localUserId]);

  // The two actions below read the whole call flow, which is a fresh object on
  // every render. Reading it through a ref rather than through the dependency
  // list is what keeps their identity stable, and a stable action identity is
  // what keeps the memoised screen renderers in `TabShell` (and the
  // `React.memo` on the screens they produce) from being invalidated by every
  // timer tick.
  const callFlowRef = useRef(callFlow);
  const settingsRef = useRef(appSettings.settings);
  useEffect(() => {
    callFlowRef.current = callFlow;
    settingsRef.current = appSettings.settings;
  }, [appSettings.settings, callFlow]);

  const endCall = useCallback(() => {
    setIsCallMinimized(false);
    callFlowRef.current.handleEndCall();
  }, [setIsCallMinimized]);

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
    const currentCallFlow = callFlowRef.current;
    const result = await exportDiagnosticLogs(
      {
        signalingUrl: currentCallFlow.signalingUrl,
        callId: currentCallFlow.activeCall?.callId ?? null,
        status: currentCallFlow.status?.message,
        localStream: currentCallFlow.localStream,
        remoteStream: currentCallFlow.remoteStream,
        isInCall: currentCallFlow.isInCall,
        iceTransportPolicy: settingsRef.current.iceTransportPolicy,
        selectedCandidatePair: currentCallFlow.selectedCandidatePair,
      },
      { userInitiated: true },
    );
    currentCallFlow.updateStatus(result.message, result.ok ? 'success' : 'error');
  }, []);

  const value = useMemo(
    () => ({
      callFlow,
      // Device preferences (see `useAppSettings`)
      settings: appSettings.settings,
      handleAutoLightingToggle: appSettings.handleAutoLightingToggle,
      handleSpeakerDefaultToggle: appSettings.handleSpeakerDefaultToggle,
      handleDeveloperModeToggle: appSettings.handleDeveloperModeToggle,
      handleHapticsToggle: appSettings.handleHapticsToggle,
      handleIceTransportPolicyChange: appSettings.handleIceTransportPolicyChange,
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
      handleTopChromeLayout,
      handleBottomChromeLayout,
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
      appSettings.handleAutoLightingToggle,
      appSettings.handleDeveloperModeToggle,
      appSettings.handleHapticsToggle,
      appSettings.handleIceTransportPolicyChange,
      appSettings.handleSpeakerDefaultToggle,
      appSettings.settings,
      callFlow,
      callState,
      endCall,
      expandCall,
      handleCallStageLayout,
      handleTopChromeLayout,
      handleBottomChromeLayout,
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

  const store = useCallStore(value);

  return <CallStoreContext.Provider value={store}>{children}</CallStoreContext.Provider>;
}

/**
 * Publish `value` through a store whose identity never changes.
 *
 * The snapshot is swapped and the subscribers are woken in a layout effect, so
 * every consumer has re-read the new slice before the frame is painted.
 *
 * @param value the freshly rendered call snapshot
 * @returns the (stable) store consumers subscribe to
 */
function useCallStore(value: CallContextValue): CallStore {
  const snapshotRef = useRef(value);
  const listenersRef = useRef((new Set<() => void>()));

  const store = useMemo(
    () => ({
      subscribe: (listener: () => void) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
      getSnapshot: () => snapshotRef.current,
    }),
    [],
  );

  useLayoutEffect(() => {
    if (snapshotRef.current === value) return;
    snapshotRef.current = value;
    // Copied first: a listener is free to unsubscribe as it is notified.
    for (const listener of Array.from(listenersRef.current)) {
      listener();
    }
  }, [value]);

  return store;
}

/**
 * Compare two selected slices one level deep.
 *
 * The default for {@link useCallSelector}, so a selector may return a plain
 * object of the fields a component reads without that object's fresh identity
 * counting as a change on every notification.
 *
 * @param a previously selected slice
 * @param b freshly selected slice
 * @returns whether the two slices hold the same values
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const left = (a as Record<string, unknown>);
  const right = (b as Record<string, unknown>);
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    key =>
      Object.prototype.hasOwnProperty.call(right, key) && Object.is(left[key], right[key]),
  );
}

/**
 * The store published by the nearest {@link CallProvider}.
 *
 * @returns the call store
 */
function useCallStoreContext(): CallStore {
  const store = useContext(CallStoreContext);
  if (!store) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return store;
}

/**
 * Subscribe to one slice of the call snapshot.
 *
 * The component re-renders only when the selected slice changes, so a call
 * timer, a connection-quality sample or a recovery attempt no longer disturbs
 * screens that read none of them. Selectors must be pure functions of the
 * snapshot — declare them at module scope rather than closing over props, since
 * the selection is cached per snapshot.
 *
 * @param select picks the slice this component reads
 * @param isEqual decides whether the newly selected slice is a change; shallow
 * by default, so an object of fields is compared field by field
 * @returns the selected slice
 */
export function useCallSelector<Selected>(
  select: (state: CallContextValue) => Selected,
  isEqual: (a: Selected, b: Selected) => boolean = shallowEqual,
): Selected {
  const store = useCallStoreContext();
  const cacheRef = useRef((null as { snapshot: CallContextValue; selected: Selected; } | null));

  const getSelection = useCallback(() => {
    const snapshot = store.getSnapshot();
    const cached = cacheRef.current;
    if (cached && cached.snapshot === snapshot) return cached.selected;
    const selected = select(snapshot);
    // Keeping the previous reference when the values match is what makes this
    // safe for `useSyncExternalStore`, which requires a cached snapshot, *and*
    // what lets a selector return a fresh object of fields.
    if (cached && isEqual(cached.selected, selected)) {
      cacheRef.current = { snapshot, selected: cached.selected };
      return cached.selected;
    }
    cacheRef.current = { snapshot, selected };
    return selected;
  }, [isEqual, select, store]);

  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

/** Identity selector for {@link useCall}. */
const selectAll = (state: CallContextValue) => state;

/**
 * Access the whole call snapshot.
 *
 * Re-renders on every call-flow change, which is what a call surface showing
 * most of the call generally wants; anything reading a handful of fields —
 * above all the chat surfaces — should select those fields with
 * {@link useCallSelector} instead.
 *
 * @returns the value published by {@link CallProvider}
 */
export function useCall(): CallContextValue {
  return useCallSelector(selectAll, Object.is);
}
