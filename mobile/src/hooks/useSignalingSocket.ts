import { useCallback } from 'react';
import { logInfo } from '../appLogger';
import type { createSignalingClient } from '../signalingClient';
import type { Socket } from 'socket.io-client';

type MutableRef<T> = { current: T };

type UseSignalingSocketParams = {
  detachManagerPingRef: MutableRef<(() => void) | null>;
  resetTypingStateRef: MutableRef<() => void>;
  signalingRef: MutableRef<ReturnType<typeof createSignalingClient> | null>;
  socketRef: MutableRef<Socket | null>;
};

/**
 * Owns the Socket.IO transport lifecycle for `useCallFlow`.
 *
 * CP5 is being wired in small steps: teardown moved first because every later
 * listener registration path depends on it and because it proves the hook can
 * own socket refs without changing reconnect behavior.
 */
export default function useSignalingSocket({
  detachManagerPingRef,
  resetTypingStateRef,
  signalingRef,
  socketRef,
}: UseSignalingSocketParams) {
  const disconnectSocket = useCallback(() => {
    detachManagerPingRef.current?.();
    detachManagerPingRef.current = null;
    if (socketRef.current) {
      logInfo('[CallFlow] Disconnecting socket');
      signalingRef.current?.dispose();
      socketRef.current.disconnect();
      socketRef.current = null;
      signalingRef.current = null;
    }
    resetTypingStateRef.current();
  }, [detachManagerPingRef, resetTypingStateRef, signalingRef, socketRef]);

  return { disconnectSocket };
}
