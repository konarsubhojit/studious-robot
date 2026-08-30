import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { logInfo, logVerbose, logWarn } from '../appLogger';
import { errorMessage } from '../errors';
import { CLIENT_EVENTS, createSignalingClient } from '../signalingClient';
import { SIGNALING_VERSION } from '../socketProtocol';
import {
  CALL_HEARTBEAT_DUE_MS,
  CALL_HEARTBEAT_INTERVAL_MS,
} from '../../../shared';
import type { Socket } from 'socket.io-client';

type MutableRef<T> = { current: T };

/**
 * Shared refs the in-call liveness heartbeat reads. They are owned by
 * `useCallFlow` (the call lifecycle mutates them) and passed in so the
 * heartbeat can prove the *current* call live without re-creating its timer.
 */
export type UseCallHeartbeatParams = {
  activeCallIdRef: MutableRef<string | null>;
  socketRef: MutableRef<Socket | null>;
  signalingRef: MutableRef<ReturnType<typeof createSignalingClient> | null>;
  isScreenSharingRef: MutableRef<boolean>;
};

export type CallHeartbeat = {
  /** Start the periodic liveness report to the server (idempotent). */
  startCallHeartbeat: (reason?: string) => void;
  /** Stop the liveness report (idempotent). */
  stopCallHeartbeat: (reason?: string) => void;
  /**
   * Ask for a beat from any wake-up source (socket ping, peer relay, AppState,
   * socket reconnect). Emits one only if a beat is actually due.
   */
  wakeCallHeartbeat: (trigger: string) => void;
};

/**
 * Owns the in-call liveness heartbeat: the periodic `call.media-state` report
 * that lets the server tell a long healthy conversation apart from one both
 * devices silently abandoned.
 *
 * The interval lives in a ref and is started/stopped by call lifecycle alone,
 * never by an effect — no view state (compact/Picture-in-Picture) or callback
 * identity may recreate or cancel it. It is only the *fast path*: Android
 * suspends the JS timer queue whenever the activity is paused (which includes
 * Picture-in-Picture, where the call is still very much alive), so every
 * wake-up source calls `wakeCallHeartbeat`, which catches up the beats the
 * suspended timer missed.
 */
export default function useCallHeartbeat({
  activeCallIdRef,
  socketRef,
  signalingRef,
  isScreenSharingRef,
}: UseCallHeartbeatParams): CallHeartbeat {
  // Periodic in-call liveness report to the server (see CALL_HEARTBEAT_INTERVAL_MS).
  // `active` is what ties the heartbeat's lifetime to the call (not to any view
  // or effect), and `lastBeatAtMs` is what lets any wake-up source emit a beat
  // that the suspended interval could not.
  const heartbeatRef = useRef({
    timer: (null as ReturnType<typeof setInterval> | null),
    lastBeatAtMs: 0,
    active: false,
  });
  // Ref-forwarded wake-up so socket listeners registered once (and the AppState
  // listener) can nudge the heartbeat without being re-registered.
  const wakeCallHeartbeatRef = useRef((null as ((trigger: string) => void) | null));

  /**
   * Stop the in-call liveness heartbeat (idempotent).
   *
   * @param reason - why the heartbeat is stopping, recorded in the log so a
   *   heartbeat that dies for the wrong reason is visible in an export.
   */
  const stopCallHeartbeat = useCallback((reason: string = 'call-ended') => {
    const heartbeat = heartbeatRef.current;
    if (heartbeat.timer) {
      clearInterval(heartbeat.timer);
      heartbeat.timer = null;
    }
    if (!heartbeat.active) return;
    heartbeat.active = false;
    heartbeat.lastBeatAtMs = 0;
    logInfo('[CallFlow] Call heartbeat stopped', {
      callId: activeCallIdRef.current,
      reason,
    });
  }, [activeCallIdRef]);

  /**
   * Emit one liveness beat, but only if one is due.
   *
   * Called by every wake-up source rather than by the interval alone, because
   * Android suspends the JS timer queue whenever the activity is paused — which
   * includes Picture-in-Picture, where the call is still very much alive. A
   * `setInterval` therefore cannot be trusted to keep the call proven live; the
   * check is against wall-clock time so whichever source does fire (an inbound
   * server ping, the peer's own relayed beat, an AppState change, a socket
   * reconnect) catches up the beats the timer missed.
   *
   * A beat that cannot be sent (socket down) deliberately does not advance
   * `lastBeatAtMs`, so the next wake-up retries immediately.
   *
   * @param trigger - which wake-up source asked, for diagnosis.
   */
  const beatCallHeartbeatIfDue = useCallback((trigger: string) => {
    const heartbeat = heartbeatRef.current;
    if (!heartbeat.active) return;
    const callId = activeCallIdRef.current;
    if (!callId) return;
    const now = Date.now();
    if (heartbeat.lastBeatAtMs && now - heartbeat.lastBeatAtMs < CALL_HEARTBEAT_DUE_MS) return;
    if (!socketRef.current?.connected) return;
    heartbeat.lastBeatAtMs = now;
    logVerbose('[CallFlow] Call heartbeat beat', { callId, trigger });
    signalingRef.current
      ?.request(CLIENT_EVENTS.CALL_MEDIA_STATE, {
        version: SIGNALING_VERSION,
        callId,
        mediaState: { isScreenSharing: isScreenSharingRef.current, heartbeat: true },
      })
      .catch(error => {
        logWarn('[CallFlow] call heartbeat failed', { message: errorMessage(error) });
      });
  }, [activeCallIdRef, isScreenSharingRef, signalingRef, socketRef]);

  useEffect(() => {
    wakeCallHeartbeatRef.current = beatCallHeartbeatIfDue;
  }, [beatCallHeartbeatIfDue]);

  /**
   * Report call liveness to the server every `CALL_HEARTBEAT_INTERVAL_MS`.
   *
   * Reuses the existing `call.media-state` relay: the server stamps the call
   * on every inbound frame, which is how it tells a long healthy conversation
   * apart from one both devices silently abandoned.
   *
   * @param reason - what started the heartbeat, recorded in the log.
   */
  const startCallHeartbeat = useCallback(
    (reason: string = 'media-connected') => {
      const heartbeat = heartbeatRef.current;
      if (heartbeat.active) return;
      heartbeat.active = true;
      heartbeat.lastBeatAtMs = Date.now();
      heartbeat.timer = setInterval(
        () => beatCallHeartbeatIfDue('interval'),
        CALL_HEARTBEAT_INTERVAL_MS,
      );
      logInfo('[CallFlow] Call heartbeat started', {
        callId: activeCallIdRef.current,
        intervalMs: CALL_HEARTBEAT_INTERVAL_MS,
        reason,
      });
    },
    [activeCallIdRef, beatCallHeartbeatIfDue],
  );

  // Beat on every foreground/background transition too: entering Picture-in-
  // Picture (or plain backgrounding) suspends the interval, and returning from
  // it must not wait a further full period to prove the call is still alive.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      wakeCallHeartbeatRef.current?.(`app-state:${nextState}`);
    });
    return () => subscription.remove();
  }, []);

  // The interval is created here, so it is cleared here too: `useCallFlow`'s
  // teardown also calls `stopCallHeartbeat('unmount')`, but an interval whose
  // lifetime is owned by another file leaks the moment that call is moved or
  // dropped. `stopCallHeartbeat` is idempotent, so the double stop is safe.
  useEffect(() => {
    return () => {
      stopCallHeartbeat('unmount');
    };
  }, [stopCallHeartbeat]);

  // Stable wrapper so socket listeners (registered once, via the URL-shared
  // Engine.IO manager) and the `call.media-state` relay can nudge the heartbeat
  // without depending on the current beat callback's identity.
  const wakeCallHeartbeat = useCallback((trigger: string) => {
    wakeCallHeartbeatRef.current?.(trigger);
  }, []);

  return { startCallHeartbeat, stopCallHeartbeat, wakeCallHeartbeat };
}
