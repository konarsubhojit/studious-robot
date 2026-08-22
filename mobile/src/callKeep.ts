import { Platform } from 'react-native';
import { logError, logInfo, logWarn } from './appLogger';
import {
  dismissIncomingCallNotification,
  showIncomingCallNotification,
} from './incomingCallNotification';
import { startIncomingRingtone, stopIncomingRingtone } from './ringtone';

/**
 * System-level incoming-call UI for the WeTalk mobile app.
 *
 * Wraps the optional `react-native-callkeep` native module, which surfaces the
 * OS call UI (Android ConnectionService / iOS CallKit) so an incoming call can
 * ring full-screen even during a cold start triggered by a background push.
 *
 * `react-native-callkeep` is an *optional* native dependency: when it (and the
 * matching Android ConnectionService / iOS entitlement) is not installed, every
 * helper below degrades gracefully to a no-op so the JS bundle still builds and
 * runs. This mirrors the optional handling of `@react-native-firebase/messaging`
 * in `pushNotifications.js` and the server's env-gated push delivery.
 */

/** Options passed to `RNCallKeep.setup`; tuned for a VoIP calling app. */
const CALLKEEP_SETUP_OPTIONS = {
  ios: {
    appName: 'WeTalk',
    supportsVideo: true,
    maximumCallGroups: '1',
    maximumCallsPerCallGroup: '1',
  },
  android: {
    alertTitle: 'Permissions required',
    alertDescription: 'WeTalk needs access to your phone-call accounts to show incoming calls',
    cancelButton: 'Cancel',
    okButton: 'OK',
    // Show the OS incoming-call UI even when the app is in the background.
    foregroundService: {
      channelId: 'com.wetalk.callkeep',
      channelName: 'Incoming calls',
      notificationTitle: 'WeTalk is running',
    },
    // Self-managed: Android Telecom creates the connection *without* showing
    // any UI of its own (that's what buys WeTalk's own branded incoming-call
    // screen instead of the generic system dialer), which means the app is
    // *required* to render — and ring — its own full-screen incoming-call
    // notification in response to CallKeep's `showIncomingCallUi` event.
    // `registerShowIncomingCallUiListener` below is that handler: it is wired
    // at module scope from `mobile/index.js` (see its own doc comment for
    // why), so it exists even in the headless JS context a background push
    // cold-starts, and it falls back to an audible ringtone
    // (`startIncomingRingtone`) whenever the branded notification can't be
    // shown. A previous self-managed attempt regressed to silent incoming
    // calls precisely because this handler did not exist yet — do not flip
    // this flag again without it.
    selfManaged: true,
    additionalPermissions: [],
  },
};

/**
 * @param {unknown} error
 * @returns {string|undefined} the error message, when there is one.
 */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * The subset of the optional `react-native-callkeep` surface this module uses.
 * Every member is optional because the package (and the test doubles) may only
 * implement part of it, which the call sites already probe for.
 */
export type CallKeep = { setup?: (options: object) => Promise<unknown>; setAvailable?: (available: boolean) => void; hasPhoneAccount?: () => Promise<boolean>; checkPhoneAccountEnabled?: () => Promise<boolean>; displayIncomingCall?: (callId: string, handle: string, name?: string, handleType?: string, hasVideo?: boolean) => void; setCurrentCallActive?: (callId: string) => void; backToForeground?: () => void; endCall?: (callId: string) => void; endAllCalls?: () => void; addEventListener?: (event: string, handler: (payload: any) => void) => void; removeEventListener?: (event: string) => void; };

/**
 * Cached result of the optional native CallKeep module lookup.
 *
 * @type {CallKeep | null | undefined}
 */
let cachedCallKeep: CallKeep | null | undefined;
let hasLoggedMissingCallKeep = false;
/** Whether `setup()` has completed successfully (guards repeated setup). */
let isConfigured = false;
/**
 * Call ids already surfaced to the OS.
 *
 * The same call can legitimately arrive over several paths at once — the
 * `call.incoming` socket event, a foreground push and a background push all
 * race for the same call — so displaying is deduplicated centrally here rather
 * than in each caller. Without this the OS would show (and ring) the same
 * incoming call more than once.
 */
const displayedCallIds = new Set<string>();

/**
 * Caller id per displayed call (`callId` → `callerId`).
 *
 * Used to replace a stale ring from the same peer: when someone cancels and
 * immediately redials, the notification for the cancelled call can still be on
 * screen, and a user tapping it answers a call that no longer exists. The new
 * call therefore dismisses the previous one from the same caller instead of
 * stacking on top of it.
 */
const displayedCallerIds = new Map<string, string>();

/**
 * The call-flow handlers currently allowed to act on CallKeep's `answerCall` /
 * `endCall` events, or `null` when nothing is attached.
 *
 * @type {{ onAnswer?: (callId: string) => void, onEnd?: (callId: string) => void } | null}
 *
 * `registerCallActionListeners` wires the *native* event subscription exactly
 * once, at module scope (see `mobile/index.js`), so it exists even in the
 * headless JS context a background push cold-starts — before any component,
 * and therefore `useCallFlow`, has mounted. `react-native-callkeep` tracks a
 * single listener per event name and `removeEventListener` unsubscribes by
 * name only, so re-registering from inside `useCallFlow`'s effect would
 * silently replace the module-scope handler, and the effect's cleanup would
 * remove it entirely the moment the component unmounts. Instead, whichever
 * call-flow consumer is mounted calls `setCallActionHandlers` to take over
 * routing of the already-subscribed events; the native subscription itself is
 * never re-registered or torn down.
 */
let activeCallActionHandlers: { onAnswer?: (callId: string) => void; onEnd?: (callId: string) => void; } | null = null;

/**
 * The single queue for an `answerCall` that cannot be acted on yet — either it
 * fired with no handler attached (the push-cold-start race, where CallKeep's OS
 * UI can be answered before `useCallFlow` has mounted and called
 * `setCallActionHandlers`), or the attached call flow does not know the call
 * yet (the `call.incoming` socket event has not landed).
 *
 * There is deliberately exactly one queue: a second queue inside the call flow
 * would mean an answer could be lost in the hand-off between the two. Every
 * enqueue, drain and drop is logged so a swallowed tap is always traceable.
 *
 * @type {string | null}
 */
let pendingAnswerCallId: string | null = null;

/**
 * Build the unsubscribe function returned by every `register*` helper, tagged
 * with whether the listener was actually registered.
 *
 * @param {boolean} registered
 * @returns {(() => void) & { registered: boolean }}
 */
function registrationResult(registered: boolean): (() => void) & { registered: boolean; } {
  const unsubscribe = ((() => {}) as (() => void) & { registered: boolean });
  unsubscribe.registered = registered;
  return unsubscribe;
}

/**
 * Lazily resolve the optional `react-native-callkeep` default export. Returns
 * the RNCallKeep singleton, or `null` when the package is not installed. The
 * lookup is memoised so a missing module is only logged once.
 *
 * @returns {CallKeep | null}
 */
export function loadCallKeep(): CallKeep | null {
  if (cachedCallKeep !== undefined) return cachedCallKeep;
  try {
    const mod = require('react-native-callkeep');
    cachedCallKeep = (/** @type {unknown} */ (mod?.default ?? mod ?? null) as CallKeep | null);
  } catch {
    cachedCallKeep = null;
    if (!hasLoggedMissingCallKeep) {
      logWarn('[CallKeep] Native callkeep module not installed; skipping system call UI');
      hasLoggedMissingCallKeep = true;
    }
  }
  return cachedCallKeep;
}

/** Reset the memoised module + configured flag (test hook). */
export function _resetCallKeepCache() {
  cachedCallKeep = undefined;
  hasLoggedMissingCallKeep = false;
  isConfigured = false;
  displayedCallIds.clear();
  displayedCallerIds.clear();
  activeCallActionHandlers = null;
  pendingAnswerCallId = null;
}

/**
 * Forget that a call was displayed, so a future call reusing the id (or a
 * retried ring after the call ended) can be surfaced again.
 *
 * @param {string} callId
 */
export function clearDisplayedCall(callId: string) {
  displayedCallIds.delete(callId);
  displayedCallerIds.delete(callId);
}

/**
 * Queue an answered call that cannot be acted on yet, so the tap is replayed
 * instead of swallowed. Supersedes any previously queued call (only one call
 * can ring at a time), logging the drop.
 *
 * @param {string} callUUID
 * @param {string} [source] - where the answer came from, for log correlation
 * @returns {boolean} `true` when the call was queued
 */
export function recordPendingAnswer(callUUID: string, source: string = 'unknown'): boolean {
  if (!callUUID) {
    logWarn('[CallKeep] Pending answer dropped; no callUUID', { source });
    return false;
  }
  if (pendingAnswerCallId && pendingAnswerCallId !== callUUID) {
    logWarn('[CallKeep] Pending answer superseded', {
      dropped: pendingAnswerCallId,
      callUUID,
      source,
    });
  }
  pendingAnswerCallId = callUUID;
  logInfo('[CallKeep] Pending answer queued', { callUUID, source });
  return true;
}

/**
 * The currently queued answered callId, or `null`.
 *
 * @returns {string | null}
 */
export function peekPendingAnswer(): string | null {
  return pendingAnswerCallId;
}

/**
 * Remove and return the queued answered callId.
 *
 * @param {string} [callUUID] - when given, only drains a matching queue entry
 * @returns {string | null} the drained callId, or `null` when nothing matched
 */
export function consumePendingAnswer(callUUID?: string): string | null {
  if (!pendingAnswerCallId) return null;
  if (callUUID && pendingAnswerCallId !== callUUID) return null;
  const drained = pendingAnswerCallId;
  pendingAnswerCallId = null;
  logInfo('[CallKeep] Pending answer drained', { callUUID: drained });
  return drained;
}

/**
 * Discard the queued answered callId (the call ended, was declined, or is no
 * longer answerable).
 *
 * @param {string} [callUUID] - when given, only drops a matching queue entry
 * @param {string} [reason]
 * @returns {boolean} `true` when an entry was dropped
 */
export function clearPendingAnswer(callUUID?: string, reason: string = 'unspecified'): boolean {
  if (!pendingAnswerCallId) return false;
  if (callUUID && pendingAnswerCallId !== callUUID) return false;
  logWarn('[CallKeep] Pending answer dropped', { callUUID: pendingAnswerCallId, reason });
  pendingAnswerCallId = null;
  return true;
}

/**
 * Whether a CallKeep setup rejection is the benign "no foreground Activity"
 * failure raised when setup runs from a background/headless context (the
 * killed-app push path) rather than a real configuration error.
 *
 * @param {{ code?: string, message?: string } | null | undefined} error
 * @returns {boolean}
 */
function isMissingActivityError(error: { code?: string; message?: string; } | null | undefined): boolean {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return code === 'E_ACTIVITY_DOES_NOT_EXIST' || /activity doesn't exist/i.test(message);
}

/**
 * Configure CallKeep once. Safe to call repeatedly; subsequent calls are no-ops
 * once setup has succeeded. Returns `false` (never throws) when the native
 * module is unavailable or setup fails.
 *
 * @returns {Promise<boolean>} `true` when CallKeep is configured and ready
 */
export async function setupCallKeep(): Promise<boolean> {
  if (isConfigured) return true;
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.setup !== 'function') return false;

  try {
    try {
      await callKeep.setup(CALLKEEP_SETUP_OPTIONS);
    } catch (error) {
      if (!isMissingActivityError((error as any))) throw error;
      // A push that cold-starts the app runs in a headless JS context with no
      // foreground Activity, so CallKeep's post-setup phone-account permission
      // prompt rejects. The native half of setup (phone-account registration,
      // event wiring) already ran synchronously before that prompt, so the
      // system call UI is still usable and the call must still ring.
      logWarn('[CallKeep] setup completed without an Activity; skipping permission prompt');
    }
    if (Platform.OS === 'android' && typeof callKeep.setAvailable === 'function') {
      callKeep.setAvailable(true);
    }
    isConfigured = true;
    logInfo('[CallKeep] System call UI configured');
    return true;
  } catch (error) {
    logError('[CallKeep] setup failed', error);
    return false;
  }
}

/**
 * Dismiss any incoming-call UI still on screen for an *earlier* call from the
 * same caller, so a redial replaces the stale ring instead of stacking on top
 * of it (and so a tap can only ever reach the call that is actually ringing).
 *
 * @param {string} callId   - the call about to be displayed
 * @param {string|null|undefined} callerId
 */
function dismissStaleCallsFromCaller(callId: string, callerId: string | null | undefined) {
  if (!callerId) return;
  for (const [displayedCallId, displayedCallerId] of displayedCallerIds) {
    if (displayedCallId === callId || displayedCallerId !== callerId) continue;
    logInfo('[CallKeep] Dismissing stale incoming call from same caller', {
      staleCallId: displayedCallId,
      callId,
      callerId,
    });
    endCall(displayedCallId);
    clearPendingAnswer(displayedCallId, 'superseded_by_new_call');
  }
}

/**
 * Display the OS incoming-call UI for a call. Never throws; failures resolve
 * with a reason that distinguishes no-op paths from Telecom errors.
 *
 * Duplicate calls for the same `callId` are ignored, so it is safe to invoke
 * this from the socket, foreground-push and background-push paths at once.
 *
 * @param {{ callId?: string, callerId?: string | null, hasVideo?: boolean }} [opts]
 * @returns {Promise<{ shown: true } | { shown: false, reason: string, message?: string }>}
 */
export async function displayIncomingCall({ callId, callerId, hasVideo = true }: { callId?: string; callerId?: string | null; hasVideo?: boolean; } = {}): Promise<{ shown: true; } | { shown: false; reason: string; message?: string; }> {
  if (!callId) return { shown: false, reason: 'missing_call_id' };
  if (displayedCallIds.has(callId)) {
    logInfo('[CallKeep] Incoming call already displayed; ignoring duplicate', { callId });
    return { shown: false, reason: 'duplicate_callId_deduped' };
  }
  if (!loadCallKeep()) {
    return { shown: false, reason: 'native_module_absent' };
  }
  const ready = await setupCallKeep();
  if (!ready) return { shown: false, reason: 'phone_account_not_registered' };

  dismissStaleCallsFromCaller(callId, callerId);

  // `loadCallKeep()` already returned a module above, so it cannot be null here.
  const callKeep = (loadCallKeep() as CallKeep);
  try {
    if (
      Platform.OS === 'android' &&
      typeof callKeep.hasPhoneAccount === 'function' &&
      !(await callKeep.hasPhoneAccount())
    ) {
      return { shown: false, reason: 'phone_account_not_registered' };
    }
    if (
      Platform.OS === 'android' &&
      typeof callKeep.checkPhoneAccountEnabled === 'function' &&
      !(await callKeep.checkPhoneAccountEnabled())
    ) {
      return { shown: false, reason: 'phone_account_disabled_by_user' };
    }
    const handle = callerId || callId;
    const name = callerId || 'Incoming call';
    displayedCallIds.add(callId);
    if (callerId) displayedCallerIds.set(callId, callerId);
    callKeep.displayIncomingCall?.(callId, handle, name, 'generic', hasVideo);
    logInfo('[CallKeep] Displayed incoming call', { callId, callerId: callerId ?? null });
    return { shown: true };
  } catch (error) {
    displayedCallIds.delete(callId);
    displayedCallerIds.delete(callId);
    logError('[CallKeep] displayIncomingCall failed', error);
    return { shown: false, reason: 'telecom_threw', message: errorMessage(error) };
  }
}

/**
 * Inform the OS that a call became connected/active so the system UI shows the
 * in-call controls instead of the ringing state.
 *
 * @param {string} callId
 * @returns {boolean} `true` when the update was sent
 */
export function reportCallConnected(callId: string): boolean {
  if (!callId) return false;
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.setCurrentCallActive !== 'function') return false;
  try {
    callKeep.setCurrentCallActive(callId);
    return true;
  } catch (error) {
    logError('[CallKeep] reportCallConnected failed', error);
    return false;
  }
}

/**
 * Ask the OS to bring the app's UI to the foreground.
 *
 * Answering from a push cold start runs with no foreground Activity, so a
 * runtime permission prompt cannot be displayed; raising the app first gives
 * the prompt (and the in-call screen) somewhere to appear.
 *
 * @returns {boolean} `true` when the request was sent
 */
export function bringAppToForeground(): boolean {
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.backToForeground !== 'function') return false;
  try {
    callKeep.backToForeground();
    logInfo('[CallKeep] Requested app foreground');
    return true;
  } catch (error) {
    logWarn('[CallKeep] backToForeground failed', { message: errorMessage(error) });
    return false;
  }
}

/**
 * Dismiss the OS call UI for a single call.
 *
 * @param {string} callId
 * @returns {boolean} `true` when the end was sent
 */
export function endCall(callId: string): boolean {
  if (!callId) return false;
  // Allow the call id to be displayed again if it ever rings anew.
  displayedCallIds.delete(callId);
  displayedCallerIds.delete(callId);
  // Idempotent no-ops when nothing was ever shown/started for this call.
  dismissIncomingCallNotification(callId);
  stopIncomingRingtone();
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.endCall !== 'function') return false;
  try {
    callKeep.endCall(callId);
    return true;
  } catch (error) {
    logError('[CallKeep] endCall failed', error);
    return false;
  }
}

/** Dismiss every active OS call UI (cleanup helper). */
export function endAllCalls() {
  for (const callId of displayedCallIds) dismissIncomingCallNotification(callId);
  displayedCallIds.clear();
  displayedCallerIds.clear();
  stopIncomingRingtone();
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.endAllCalls !== 'function') return false;
  try {
    callKeep.endAllCalls();
    return true;
  } catch (error) {
    logError('[CallKeep] endAllCalls failed', error);
    return false;
  }
}

/**
 * Wire CallKeep's `answerCall` / `endCall` native event subscription.
 *
 * Intended to be called exactly once, at module scope (`mobile/index.js`),
 * so the subscription exists even in the headless JS context a background
 * push cold-starts — long before any component has mounted. Events are
 * routed to whichever handler `setCallActionHandlers` most recently attached;
 * when none is attached, an `answerCall` event is queued (see
 * `pendingAnswerCallId`) rather than dropped, and an `endCall` event just
 * forgets the call locally so a retried ring can still be displayed.
 *
 * No-ops (returning a no-op unsubscribe) when CallKeep is unavailable. The
 * returned unsubscribe is a last-resort teardown (e.g. app shutdown in
 * tests); ordinary consumers should use `setCallActionHandlers` instead of
 * calling this more than once.
 *
 * @returns {(() => void) & { registered: boolean }} unsubscribe function, tagged
 *   with whether the native listener was registered
 */
export function registerCallActionListeners(): (() => void) & { registered: boolean; } {
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.addEventListener !== 'function') {
    logWarn('[CallKeep] call action listeners not registered; native module unavailable');
    return registrationResult(false);
  }

  const answerHandler = (/** @type {any} */ { callUUID }: any = {}) => {
    logInfo('[CallKeep] answerCall', {
      callUUID,
      hasActiveHandler: Boolean(activeCallActionHandlers),
    });
    dismissIncomingCallNotification(callUUID);
    stopIncomingRingtone();
    if (activeCallActionHandlers?.onAnswer) {
      activeCallActionHandlers.onAnswer(callUUID);
      return;
    }
    logWarn('[CallKeep] answerCall received with no call flow attached; queuing for replay', {
      callUUID,
    });
    recordPendingAnswer(callUUID, 'native_no_handler');
  };
  const endHandler = (/** @type {any} */ { callUUID }: any = {}) => {
    logInfo('[CallKeep] endCall', {
      callUUID,
      hasActiveHandler: Boolean(activeCallActionHandlers),
    });
    dismissIncomingCallNotification(callUUID);
    stopIncomingRingtone();
    if (pendingAnswerCallId === callUUID) clearPendingAnswer(callUUID, 'call_ended');
    if (activeCallActionHandlers?.onEnd) {
      activeCallActionHandlers.onEnd(callUUID);
      return;
    }
    // No call flow is attached to notify the server of the decline; forget
    // the call locally so a retried ring for the same id can still surface.
    clearDisplayedCall(callUUID);
  };

  try {
    callKeep.addEventListener?.('answerCall', answerHandler);
    callKeep.addEventListener?.('endCall', endHandler);
  } catch (error) {
    logError('[CallKeep] registerCallActionListeners failed', error);
    return registrationResult(false);
  }

  const unsubscribe = () => {
    try {
      // react-native-callkeep tracks a single listener per event name, so it
      // unsubscribes by event name only (no handler reference required).
      callKeep.removeEventListener?.('answerCall');
      callKeep.removeEventListener?.('endCall');
    } catch (error) {
      logWarn('[CallKeep] removeEventListener failed', { message: errorMessage(error) });
    }
  };
  unsubscribe.registered = true;
  return unsubscribe;
}

/**
 * Wire CallKeep's `showIncomingCallUi` native event — the event a
 * self-managed Android phone account fires in place of drawing its own
 * ringing UI (see the `selfManaged` comment in `CALLKEEP_SETUP_OPTIONS`).
 *
 * Intended to be called exactly once, at module scope (`mobile/index.js`),
 * for the same reason as `registerCallActionListeners`: the ConnectionService
 * that triggers this event runs in-process, so it can fire before any
 * component — and therefore before any app-level "is my UI ready" state —
 * has mounted, including in the headless JS context a background push
 * cold-starts.
 *
 * On every `showIncomingCallUi`, WeTalk's own branded, full-screen-intent
 * notification (`incomingCallNotification.js`) is shown. If that fails for
 * any reason (module missing, native `show()` throws, OS denial), a plain
 * audible ringtone (`startIncomingRingtone`) is started instead — a silently
 * failed branded UI is strictly worse than an ugly one, so this fallback is
 * unconditional, not best-effort.
 *
 * No-ops (returning a no-op unsubscribe) when CallKeep is unavailable.
 *
 * @returns {(() => void) & { registered: boolean }} unsubscribe function, tagged
 *   with whether the native listener was registered
 */
export function registerShowIncomingCallUiListener(): (() => void) & { registered: boolean; } {
  const callKeep = loadCallKeep();
  if (!callKeep || typeof callKeep.addEventListener !== 'function') {
    logWarn('[CallKeep] showIncomingCallUi listener not registered; native module unavailable');
    return registrationResult(false);
  }

  const handler = async (/** @type {any} */ { callUUID, handle, name }: any = {}) => {
    logInfo('[CallKeep] showIncomingCallUi', { callUUID });
    const shown = await showIncomingCallNotification({
      callId: callUUID,
      callerId: name || handle,
    }).catch(error => {
      logError('[CallKeep] showIncomingCallNotification threw', error);
      return false;
    });

    if (!shown) {
      logWarn('[CallKeep] Branded incoming-call UI unavailable; falling back to audible ring', {
        callUUID,
      });
      startIncomingRingtone();
    }
  };

  try {
    callKeep.addEventListener?.('showIncomingCallUi', handler);
  } catch (error) {
    logError('[CallKeep] registerShowIncomingCallUiListener failed', error);
    return registrationResult(false);
  }

  const unsubscribe = () => {
    try {
      callKeep.removeEventListener?.('showIncomingCallUi');
    } catch (error) {
      logWarn('[CallKeep] removeEventListener failed', { message: errorMessage(error) });
    }
  };
  unsubscribe.registered = true;
  return unsubscribe;
}

/**
 * Attach the call-flow handlers that should act on CallKeep's `answerCall` /
 * `endCall` events from now on, without touching the native subscription
 * wired by `registerCallActionListeners`. Intended to be called from
 * `useCallFlow`'s mount effect, and the returned function from its cleanup.
 *
 * If an `answerCall` fired earlier with no handler attached (the push
 * cold-start race — see `registerCallActionListeners`), it is replayed
 * synchronously to `onAnswer` here rather than lost.
 *
 * @param {{
 *   onAnswer?: (callId: string) => void,
 *   onEnd?: (callId: string) => void,
 * }} handlers
 * @returns {() => void} detach function; only clears this call's handlers if
 *   they are still the active ones (a later `setCallActionHandlers` call
 *   already having taken over is left untouched).
 */
export function setCallActionHandlers({ onAnswer, onEnd }: {
    onAnswer?: (callId: string) => void;
    onEnd?: (callId: string) => void;
} = {}): () => void {
  const handlers = { onAnswer, onEnd };
  activeCallActionHandlers = handlers;

  if (pendingAnswerCallId) {
    // `pendingAnswerCallId` is set, so the queue always drains to a call id.
    const callUUID = (consumePendingAnswer() as string);
    logInfo('[CallKeep] Replaying queued answerCall', { callUUID });
    onAnswer?.(callUUID);
  }

  return () => {
    if (activeCallActionHandlers === handlers) {
      activeCallActionHandlers = null;
    }
  };
}
