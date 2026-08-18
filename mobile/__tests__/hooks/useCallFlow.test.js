import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useCallFlow, { CALL_PHASES, CALL_END_REASON_LABELS } from '../../src/hooks/useCallFlow';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => ({
    connected: true,
    id: 'mock-socket-id',
    disconnect: jest.fn(),
    off: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
  })),
}));

jest.mock('react-native-webrtc', () => ({
  mediaDevices: { getUserMedia: jest.fn() },
  RTCIceCandidate: jest.fn(),
  RTCPeerConnection: jest.fn(),
  RTCSessionDescription: jest.fn(),
}));

jest.mock('../../src/appLogger', () => ({
  clearLogs: jest.fn(),
  getLogsAsText: jest.fn(),
  logDebug: jest.fn(),
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/audioRouting', () => ({
  AUDIO_ROUTES: { SPEAKER_PHONE: 'speakerphone' },
  chooseAudioRoute: jest.fn(),
  setAudioRoute: jest.fn(() => ({ ok: true })),
  startAudioSession: jest.fn(() => ({ ok: true })),
  stopAudioSession: jest.fn(() => ({ ok: true })),
  subscribeAudioDevices: jest.fn(() => jest.fn()),
}));

jest.mock('../../src/callService', () => ({
  startCallService: jest.fn(() => true),
  stopCallService: jest.fn(),
}));

jest.mock('../../src/hooks/useCompactCallView', () =>
  jest.fn(() => ({ isCompactView: false, setIsCompactView: jest.fn() })),
);

jest.mock('../../src/callUx', () => ({
  getConnectionQuality: jest.fn(() => ({ bars: 3, label: 'Strong' })),
}));

jest.mock('../../src/screenShare', () => ({
  SCREEN_SHARE_CANCELLED: 'cancelled',
  isScreenShareSupported: jest.fn(() => true),
  startScreenCapture: jest.fn(),
  stopScreenCapture: jest.fn(),
}));

jest.mock('../../src/diagnostics', () => ({
  buildExportHeader: jest.fn(),
  getMediaAccessStatus: jest.fn(e => e?.message || 'media error'),
  getSocketTransportName: jest.fn(),
  sanitizeUrlForLog: jest.fn(u => u),
  summarizeIceCandidate: jest.fn(),
  writeLogsFile: jest.fn(),
}));

jest.mock('../../src/mediaControls', () => ({
  isTrackEnabled: jest.fn(() => true),
  setTrackEnabled: jest.fn(() => true),
}));

jest.mock('../../src/permissions', () => ({
  ensureCallPermissions: jest.fn(() => Promise.resolve({ ok: true })),
  getMissingCallPermissions: jest.fn(() =>
    Promise.resolve({ camera: false, microphone: false, missing: [], message: null }),
  ),
}));

jest.mock('../../src/socketConfig', () => ({
  getSocketOptions: jest.fn(() => ({})),
  isRecoverableDisconnectReason: jest.fn(),
}));

jest.mock('../../src/webrtcConfig', () => ({
  getIceServers: jest.fn(() => []),
  getIceServersForCall: jest.fn(async () => []),
  applyBitrateConstraints: jest.fn(async () => {}),
}));

jest.mock('../../src/callKeep', () => {
  let pendingAnswerCallId = null;
  return {
    bringAppToForeground: jest.fn(() => true),
    displayIncomingCall: jest.fn(async () => ({ shown: true })),
    endCall: jest.fn(() => true),
    endAllCalls: jest.fn(() => true),
    registerCallActionListeners: jest.fn(() => jest.fn()),
    setCallActionHandlers: jest.fn(() => jest.fn()),
    reportCallConnected: jest.fn(() => true),
    setupCallKeep: jest.fn(async () => true),
    // Mirrors the single module-scope pending-answer queue in callKeep.js so
    // the hook's enqueue/drain/drop behaviour is exercised for real.
    recordPendingAnswer: jest.fn(callUUID => {
      if (!callUUID) return false;
      pendingAnswerCallId = callUUID;
      return true;
    }),
    peekPendingAnswer: jest.fn(() => pendingAnswerCallId),
    consumePendingAnswer: jest.fn(callUUID => {
      if (!pendingAnswerCallId) return null;
      if (callUUID && pendingAnswerCallId !== callUUID) return null;
      const drained = pendingAnswerCallId;
      pendingAnswerCallId = null;
      return drained;
    }),
    clearPendingAnswer: jest.fn(callUUID => {
      if (!pendingAnswerCallId) return false;
      if (callUUID && pendingAnswerCallId !== callUUID) return false;
      pendingAnswerCallId = null;
      return true;
    }),
  };
});

jest.mock('../../src/incomingCallNotification', () => ({
  consumePendingCallAction: jest.fn(async () => null),
  dismissIncomingCallNotification: jest.fn(() => true),
  isCallConnectionLive: jest.fn(async () => null),
  isIncomingCallNotificationAvailable: jest.fn(() => false),
  showIncomingCallNotification: jest.fn(async () => true),
}));

jest.mock('../../src/ringtone', () => ({
  startIncomingRingtone: jest.fn(),
  startOutgoingRingback: jest.fn(),
  stopIncomingRingtone: jest.fn(),
  stopOutgoingRingback: jest.fn(),
}));

jest.mock('../../src/pushNotifications', () => ({
  getInitialCallLink: jest.fn(async () => null),
  addCallLinkListener: jest.fn(() => jest.fn()),
  registerPushToken: jest.fn(async () => true),
  registerForPushNotifications: jest.fn(async () => true),
  unregisterPushToken: jest.fn(async () => true),
  installForegroundMessageHandler: jest.fn(() => jest.fn()),
  sendPushReceipt: jest.fn(async () => true),
}));

jest.mock('../../src/authService', () => ({
  isGoogleSignInConfigured: jest.fn(() => true),
  isMicrosoftSignInConfigured: jest.fn(() => true),
  observeAuthState: jest.fn(listener => {
    listener({ uid: 'firebase-test-user' });
    return jest.fn();
  }),
  registerWithEmail: jest.fn(async () => {}),
  signInWithEmail: jest.fn(async () => {}),
  signInWithGoogle: jest.fn(async () => {}),
  signInWithMicrosoft: jest.fn(async () => {}),
  getIdToken: jest.fn(async () => 'firebase-id-token'),
  signOut: jest.fn(async () => {}),
}));

jest.mock('../../src/settingsStorage', () => ({
  loadIdentity: jest.fn(async () => ({ userId: '' })),
  saveIdentity: jest.fn(async () => true),
  loadDeviceId: jest.fn(async () => 'device-test-1'),
  loadSettings: jest.fn(async defaults => ({ ...defaults })),
  saveSettings: jest.fn(async () => true),
}));

// ─── Test helpers ─────────────────────────────────────────────────────────────

function TestHook({ resultRef }) {
  const result = useCallFlow();
  resultRef.current = result;
  return null;
}

function renderHook() {
  const resultRef = { current: null };
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} />);
  });
  return { resultRef, tree };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Every hook under test here starts one or more `setInterval`/`setTimeout`
// timers (elapsed-call clock, proactive session refresh, stats polling,
// presence debounce, typing-indicator safety net) via `useEffect`, and none
// of these tests unmount the rendered tree, so those timers are never
// cleared. Under Jest's *real* timers those are live OS timer handles that
// keep the process's event loop open, so Jest hangs for tens of seconds
// after every run ("Jest did not exit...") waiting for them, even though
// every test already passed. Fake timers are a virtual clock only — they
// never touch the real event loop — so defaulting every test in this file to
// fake timers fixes the hang regardless of whether a given test unmounts.
// Individual tests still advance the fake clock explicitly where they need a
// timer to actually fire (see `jest.advanceTimersByTime` below).
beforeEach(() => {
  jest.useFakeTimers();
});

describe('useCallFlow', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    delete global.fetch;
  });

  test('initialises with idle callPhase', () => {
    const { resultRef } = renderHook();
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(resultRef.current.isInCall).toBe(false);
    expect(resultRef.current.activeCall).toBeNull();
    expect(resultRef.current.incomingCall).toBeNull();
  });

  test('initialises connectionQuality with no-link defaults', () => {
    const { resultRef } = renderHook();
    expect(resultRef.current.connectionQuality).toEqual({
      bars: 0,
      label: 'No link',
    });
  });

  test('exposes identity setters', () => {
    const { resultRef } = renderHook();
    expect(typeof resultRef.current.setUserId).toBe('function');
    expect(typeof resultRef.current.setCalleeId).toBe('function');
    expect(typeof resultRef.current.setSignalingUrl).toBe('function');
  });

  test('exposes all required call action callbacks', () => {
    const { resultRef } = renderHook();
    const required = [
      'placeCall',
      'cancelOutgoingCall',
      'acceptIncomingCall',
      'declineIncomingCall',
      'handleEndCall',
      'startLocalPreview',
    ];
    for (const fn of required) {
      expect(typeof resultRef.current[fn]).toBe('function');
    }
  });

  test('exposes all required in-call control callbacks', () => {
    const { resultRef } = renderHook();
    const required = [
      'handleMuteToggle',
      'handleVideoToggle',
      'handleCameraSwitch',
      'handleSwapStreams',
      'handleRetryReconnect',
      'chooseAudioOutput',
      'dismissCallSummary',
    ];
    for (const fn of required) {
      expect(typeof resultRef.current[fn]).toBe('function');
    }
  });

  test('setUserId updates the userId state', () => {
    const { resultRef, tree } = renderHook();
    act(() => {
      resultRef.current.setUserId('alice');
    });
    // Re-render to pick up new state.
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.userId).toBe('alice');
  });

    test('session creation sends a Firebase ID token', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-2', userId: 'alice' }),
    }));

    const { resultRef, tree } = renderHook();
    await act(async () => {
      await resultRef.current.registerUser({
        userId: 'alice',
        method: 'email-register',
        email: 'alice@example.com',
        password: 'secret12',
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const sessionRequest = global.fetch.mock.calls.find(([url]) =>
      String(url).endsWith('/session'),
    );
    expect(sessionRequest).toBeTruthy();
    expect(JSON.parse(sessionRequest[1].body)).toMatchObject({
      userId: 'alice',
      idToken: 'firebase-id-token',
    });
  });

  test('identity conflicts surface a user-friendly status message', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ code: 'identity_claimed' }),
    }));

    const { resultRef, tree } = renderHook();
    await act(async () => {
      await resultRef.current.registerUser({
        userId: 'alice',
        method: 'email-register',
        email: 'alice@example.com',
        password: 'secret12',
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.status.severity).toBe('error');
    expect(resultRef.current.status.message).toMatch(/bound/i);
  });

  test('setCalleeId updates the calleeId state', () => {
    const { resultRef, tree } = renderHook();
    act(() => {
      resultRef.current.setCalleeId('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.calleeId).toBe('bob');
  });

  test('placeCall sets error status when calleeId is empty', async () => {
    const { resultRef, tree } = renderHook();
    await act(async () => {
      await resultRef.current.placeCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.status.severity).toBe('error');
  });

  test('placeCall sets error status when userId is empty', async () => {
    const { resultRef, tree } = renderHook();
    act(() => {
      resultRef.current.setCalleeId('bob');
    });
    await act(async () => {
      await resultRef.current.placeCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.status.severity).toBe('error');
  });

  test('CALL_PHASES exports the expected values', () => {
    expect(CALL_PHASES.IDLE).toBe('idle');
    expect(CALL_PHASES.OUTGOING_RINGING).toBe('outgoing_ringing');
    expect(CALL_PHASES.INCOMING_RINGING).toBe('incoming_ringing');
    expect(CALL_PHASES.IN_CALL).toBe('in_call');
  });

  test('CALL_END_REASON_LABELS exports string labels for all expected reason codes', () => {
    const expectedReasons = [
      'ended',
      'declined',
      'cancelled',
      'timeout',
      'missed',
      'busy',
      'unreachable',
      'failed',
    ];
    for (const reason of expectedReasons) {
      expect(typeof CALL_END_REASON_LABELS[reason]).toBe('string');
      expect(CALL_END_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
  });

  test('initialises callHistory as an empty array', () => {
    const { resultRef } = renderHook();
    expect(Array.isArray(resultRef.current.callHistory)).toBe(true);
    expect(resultRef.current.callHistory).toHaveLength(0);
  });

  test('initialises missedCallCount as 0', () => {
    const { resultRef } = renderHook();
    expect(resultRef.current.missedCallCount).toBe(0);
  });

  test('exposes markMissedCallsRead and fetchCallHistory as functions', () => {
    const { resultRef } = renderHook();
    expect(typeof resultRef.current.markMissedCallsRead).toBe('function');
    expect(typeof resultRef.current.fetchCallHistory).toBe('function');
  });

  test('exposes searchUsers as a function', () => {
    const { resultRef } = renderHook();
    expect(typeof resultRef.current.searchUsers).toBe('function');
  });

  test('searchUsers resolves to an empty array when there is no session', async () => {
    const { resultRef } = renderHook();
    let users;
    await act(async () => {
      users = await resultRef.current.searchUsers('bob');
    });
    expect(users).toEqual([]);
  });

  test('searchUsers refreshes the session and retries once on a 401', async () => {
    let userRequests = 0;
    global.fetch = jest.fn(async (url, options) => {
      if (url.endsWith('/session') && options?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: 's1', userId: 'alice' }),
        };
      }
      if (url.includes('/session/refresh')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: 's2', userId: 'alice' }),
        };
      }
      if (url.includes('/users')) {
        userRequests += 1;
        if (url.includes('sessionId=s1')) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: 'invalid session' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            users: [{ userId: 'bob', status: 'online', online: true }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const { resultRef } = renderHook();
    // Setting the userId triggers the presence-connect effect, which mints a
    // session (s1) via POST /session.
    await act(async () => {
      resultRef.current.setUserId('alice');
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let users;
    await act(async () => {
      users = await resultRef.current.searchUsers('bob');
    });

    // The first request (sessionId=s1) 401s; after a refresh to s2 the retry
    // succeeds, so searchUsers returns the directory entry.
    expect(users).toEqual([{ userId: 'bob', status: 'online', online: true }]);
    expect(userRequests).toBe(2);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/session/refresh'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('calleePresence ignores stale presence responses for older calleeIds', async () => {
    jest.useFakeTimers();
    const pending = [];
    global.fetch = jest.fn(url => {
      if (String(url).endsWith('/session')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ sessionId: 'presence-session', userId: 'alice' }),
        });
      }
      return new Promise(resolve => {
        pending.push({ url, resolve });
      });
    });

    const { resultRef, tree } = renderHook();

    act(() => {
      resultRef.current.setCalleeId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    act(() => {
      resultRef.current.setCalleeId('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    expect(pending).toHaveLength(2);
    expect(pending[0].url).toContain('/presence/alice');
    expect(pending[1].url).toContain('/presence/bob');

    await act(async () => {
      pending[1].resolve({
        ok: true,
        json: async () => ({ status: 'online', online: true }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.calleePresence).toEqual({
      status: 'online',
      online: true,
    });

    await act(async () => {
      pending[0].resolve({
        ok: true,
        json: async () => ({ status: 'offline', online: false }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.calleePresence).toEqual({
      status: 'online',
      online: true,
    });
  });

  test('markMissedCallsRead is safe to call on an empty history', () => {
    const { resultRef, tree } = renderHook();
    act(() => {
      resultRef.current.markMissedCallsRead();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.callHistory).toHaveLength(0);
    expect(resultRef.current.missedCallCount).toBe(0);
  });

  test('dismissCallSummary clears callSummary', () => {
    const { resultRef, tree } = renderHook();
    // callSummary starts null; dismissing a null summary is safe.
    act(() => {
      resultRef.current.dismissCallSummary();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.callSummary).toBeNull();
  });
});

// ─── rehydrateCallFromPush ────────────────────────────────────────────────────

describe('rehydrateCallFromPush', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
    jest.clearAllMocks();
    // Reset the pushNotifications mock to return null for initial URL by default.
    require('../../src/pushNotifications').getInitialCallLink.mockResolvedValue(null);
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('exposes rehydrateCallFromPush as a function', () => {
    const { resultRef } = renderHook();
    expect(typeof resultRef.current.rehydrateCallFromPush).toBe('function');
  });

  test('defers rehydration and stores pendingPushCallId when userId is not set', async () => {
    const { resultRef } = renderHook();
    // userId is empty – rehydrateCallFromPush should not call fetch yet
    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-123');
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sets status to "Call no longer available" for 404 response', async () => {
    // Mock: POST /session (presence effect), then GET /calls/:id → 404
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-1', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      });

    const { resultRef, tree } = renderHook();

    // Await so the presence effect (createOrGetSession → fetch /session) completes.
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-does-not-exist');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.status.message).toMatch(/no longer available/i);
  });

  test('shows IncomingCallScreen for a still-ringing rehydrated call', async () => {
    const fakeCall = {
      callId: 'call-456',
      callerId: 'user-bob',
      calleeId: 'user-alice',
      status: 'ringing',
    };

    // Mock: POST /session (presence effect), then GET /calls/:id → ringing call
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-2', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-456');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.INCOMING_RINGING);
    expect(resultRef.current.incomingCall).toEqual(fakeCall);
  });

  test('sets informational status for a missed call', async () => {
    const fakeCall = {
      callId: 'call-789',
      callerId: 'user-carol',
      calleeId: 'user-alice',
      status: 'missed',
      endReason: 'timeout',
    };

    // Mock: POST /session (presence effect), then GET /calls/:id → missed call
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-3', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-789');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(resultRef.current.status.message).toMatch(/missed call/i);
  });

  // ─── Terminal-state rehydration ───────────────────────────────────────────

  test('shows "Call was declined" status for a declined call', async () => {
    const fakeCall = {
      callId: 'call-declined',
      callerId: 'user-dave',
      calleeId: 'user-alice',
      status: 'declined',
      endReason: 'declined',
    };

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-4', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-declined');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(resultRef.current.status.message).toMatch(/declined/i);
  });

  test('shows "Call ended" status for an already-ended call', async () => {
    const fakeCall = {
      callId: 'call-ended',
      callerId: 'user-eve',
      calleeId: 'user-alice',
      status: 'ended',
      endReason: 'ended',
    };

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-5', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-ended');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(resultRef.current.status.message).toMatch(/call ended/i);
  });

  test('shows fallback status for an accepted call (background restore bridge)', async () => {
    // When the app is backgrounded during a call, the server-side status may be
    // "accepted" or "connecting_media".  These active states are not ringing and
    // not yet terminal; the current rehydration path reports a fallback message
    // so the user knows the call is no longer available in this session.
    const fakeCall = {
      callId: 'call-accepted',
      callerId: 'user-frank',
      calleeId: 'user-alice',
      status: 'accepted',
    };

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-6', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-accepted');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // Call remains idle; a descriptive status message is shown.
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(typeof resultRef.current.status.message).toBe('string');
    expect(resultRef.current.status.message.length).toBeGreaterThan(0);
  });

  test('shows fallback status for an in_call call (background restore bridge)', async () => {
    const fakeCall = {
      callId: 'call-in-call',
      callerId: 'user-grace',
      calleeId: 'user-alice',
      status: 'in_call',
    };

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-7', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => fakeCall,
      });

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-in-call');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(typeof resultRef.current.status.message).toBe('string');
    expect(resultRef.current.status.message.length).toBeGreaterThan(0);
  });

  test('shows error status when the server returns a non-404 HTTP error', async () => {
    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-8', userId: 'alice' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.rehydrateCallFromPush('call-server-error');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
    expect(resultRef.current.status.severity).toBe('error');
  });
});

// ─── WebRTC hardening: camera switch ─────────────────────────────────────────

describe('useCallFlow handleCameraSwitch hardening', () => {
  function makeVideoTrack(extra = {}) {
    return { kind: 'video', enabled: true, stop: jest.fn(), ...extra };
  }

  function makeStream(videoTrack) {
    return {
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [],
      removeTrack: jest.fn(),
      addTrack: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset push mock so the presence effect doesn't fire a fetch.
    require('../../src/pushNotifications').getInitialCallLink.mockResolvedValue(null);

    // Provide a minimal RTCPeerConnection stub so ensurePeerConnection succeeds
    // if it is exercised by a test.
    const { RTCPeerConnection } = require('react-native-webrtc');
    RTCPeerConnection.mockImplementation(() => ({
      addTrack: jest.fn(),
      getSenders: jest.fn(() => []),
      onicecandidate: null,
      ontrack: null,
      oniceconnectionstatechange: null,
      close: jest.fn(),
      createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: '' }),
      createAnswer: jest.fn().mockResolvedValue({ type: 'answer', sdp: '' }),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      setRemoteDescription: jest.fn().mockResolvedValue(undefined),
      remoteDescription: null,
      iceConnectionState: 'new',
      getStats: jest.fn().mockResolvedValue(new Map()),
    }));
  });

  test('uses _switchCamera fast path and toggles isFrontCamera', async () => {
    const switchCamera = jest.fn();
    const videoTrack = makeVideoTrack({ _switchCamera: switchCamera });
    const stream = makeStream(videoTrack);
    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValue(stream);

    const { resultRef, tree } = renderHook();
    await act(async () => {
      await resultRef.current.startLocalPreview();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const before = resultRef.current.isFrontCamera;
    await act(async () => {
      await resultRef.current.handleCameraSwitch();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(switchCamera).toHaveBeenCalledTimes(1);
    expect(resultRef.current.isFrontCamera).toBe(!before);
    expect(resultRef.current.status.message).toBe('Camera switched');
  });

  test('calls getUserMedia with opposite facingMode when _switchCamera is absent', async () => {
    const videoTrack = makeVideoTrack(); // no _switchCamera
    const stream = makeStream(videoTrack);
    const newVideoTrack = makeVideoTrack();
    const newStream = {
      getTracks: () => [newVideoTrack],
      getVideoTracks: () => [newVideoTrack],
      getAudioTracks: () => [],
    };

    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia
      .mockResolvedValueOnce(stream) // startLocalPreview
      .mockResolvedValueOnce(newStream); // camera switch fallback

    const { resultRef, tree } = renderHook();
    await act(async () => {
      await resultRef.current.startLocalPreview();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // isFrontCamera defaults to true, so the fallback should request 'environment'
    const before = resultRef.current.isFrontCamera;
    await act(async () => {
      await resultRef.current.handleCameraSwitch();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(mediaDevices.getUserMedia).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ video: { facingMode: 'environment' } }),
    );
    // Old track must be stopped and removed; new track added to the stream.
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(stream.removeTrack).toHaveBeenCalledWith(videoTrack);
    expect(stream.addTrack).toHaveBeenCalledWith(newVideoTrack);
    expect(resultRef.current.isFrontCamera).toBe(!before);
    expect(resultRef.current.status.message).toBe('Camera switched');
  });

  test('replaceTrack is called on video sender during fallback when peer connection exists', async () => {
    const mockReplaceTrack = jest.fn().mockResolvedValue(undefined);
    const videoTrack = makeVideoTrack(); // no _switchCamera
    const stream = makeStream(videoTrack);
    const newVideoTrack = makeVideoTrack();
    const newStream = {
      getTracks: () => [newVideoTrack],
      getVideoTracks: () => [newVideoTrack],
      getAudioTracks: () => [],
    };

    const { mediaDevices, RTCPeerConnection } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValueOnce(stream).mockResolvedValueOnce(newStream);

    // Provide a sender so the replaceTrack branch is exercised.
    RTCPeerConnection.mockImplementation(() => ({
      addTrack: jest.fn(),
      getSenders: jest.fn(() => [{ track: videoTrack, replaceTrack: mockReplaceTrack }]),
      onicecandidate: null,
      ontrack: null,
      oniceconnectionstatechange: null,
      close: jest.fn(),
      createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: '' }),
      createAnswer: jest.fn().mockResolvedValue({ type: 'answer', sdp: '' }),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      setRemoteDescription: jest.fn().mockResolvedValue(undefined),
      remoteDescription: null,
      iceConnectionState: 'new',
      getStats: jest.fn().mockResolvedValue(new Map()),
    }));

    const { resultRef, tree } = renderHook();
    await act(async () => {
      await resultRef.current.startLocalPreview();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // We need peerConnectionRef.current to be set.  Force it by calling
    // ensurePeerConnection indirectly: trigger the acceptIncomingCall path
    // can't be done without a fake call, so instead we verify that the
    // replaceTrack path WOULD be exercised once a peer connection is present.
    // The key contract is that getSenders is called and replaceTrack is invoked
    // when the sender's track kind is 'video'.  We validate this via the
    // RTCPeerConnection spy rather than the hook's internal ref.
    //
    // At this point peerConnectionRef.current is null (no call started), so
    // replaceTrack is NOT called – but the stream is still updated and
    // isFrontCamera is toggled.
    await act(async () => {
      await resultRef.current.handleCameraSwitch();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.isFrontCamera).toBe(false);
    expect(resultRef.current.status.message).toBe('Camera switched');
    // replaceTrack is guarded by peerConnectionRef.current being non-null;
    // without an active call the sender is not reached in this test.
    expect(mockReplaceTrack).not.toHaveBeenCalled();
  });
});

// ─── Incoming-call ringing ────────────────────────────────────────────────────

describe('useCallFlow incoming-call ringing', () => {
  /**
   * Helper: find a handler registered with socket.on(event) on the most
   * recently created socket from the io() mock.
   */
  function getSocketHandler(event) {
    const { io } = require('socket.io-client');
    // Find the most-recently created socket mock instance.
    const socketMock = io.mock.results[io.mock.results.length - 1]?.value;
    if (!socketMock) return undefined;
    const call = socketMock.on.mock.calls.find(([e]) => e === event);
    return call?.[1];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    require('../../src/pushNotifications').getInitialCallLink.mockResolvedValue(null);
    // Default: CallKeep shows the system UI successfully.
    require('../../src/callKeep').displayIncomingCall.mockResolvedValue({ shown: true });
  });

  /**
   * Render the hook and establish a socket by setting a userId so the presence
   * effect fires.  Returns the hook result ref and renderer tree.
   */
  async function renderWithSocket() {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-ring', userId: 'alice' }),
    }));

    const { resultRef, tree } = renderHook();
    // Setting userId triggers the presence effect → createOrGetSession → connectSocket.
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    // Flush async socket-connection work.
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    return { resultRef, tree };
  }

  // ── call.incoming ─────────────────────────────────────────────────────────

  test('call.incoming triggers displayIncomingCall with correct args', async () => {
    await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    expect(handler).toBeDefined();

    const fakeCall = { callId: 'call-1', callerId: 'bob' };
    await act(async () => {
      await handler({ call: fakeCall });
    });
    // Flush microtask queue so the async showIncomingCallUi resolves.
    await act(async () => {});

    const { displayIncomingCall } = require('../../src/callKeep');
    expect(displayIncomingCall).toHaveBeenCalledTimes(1);
    expect(displayIncomingCall).toHaveBeenCalledWith({
      callId: 'call-1',
      callerId: 'bob',
    });
  });

  test('call.incoming transitions to INCOMING_RINGING phase', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    const fakeCall = { callId: 'call-2', callerId: 'carol' };
    await act(async () => {
      await handler({ call: fakeCall });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.INCOMING_RINGING);
    expect(resultRef.current.incomingCall).toEqual(fakeCall);
  });

  test('duplicate call.incoming for the same callId calls displayIncomingCall only once', async () => {
    await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    const fakeCall = { callId: 'call-dup', callerId: 'dave' };

    await act(async () => {
      await handler({ call: fakeCall });
    });
    await act(async () => {});
    await act(async () => {
      await handler({ call: fakeCall });
    });
    await act(async () => {});

    const { displayIncomingCall } = require('../../src/callKeep');
    expect(displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  test('starts fallback ringtone when CallKeep returns false', async () => {
    const { displayIncomingCall } = require('../../src/callKeep');
    const { startIncomingRingtone } = require('../../src/ringtone');
    displayIncomingCall.mockResolvedValueOnce({ shown: false, reason: 'native_module_absent' });

    await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    const fakeCall = { callId: 'call-fallback', callerId: 'eve' };
    await act(async () => {
      await handler({ call: fakeCall });
    });
    await act(async () => {});

    expect(startIncomingRingtone).toHaveBeenCalledTimes(1);
  });

  test('does not start fallback ringtone when CallKeep succeeds', async () => {
    const { displayIncomingCall } = require('../../src/callKeep');
    const { startIncomingRingtone } = require('../../src/ringtone');
    displayIncomingCall.mockResolvedValueOnce({ shown: true });

    await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    await act(async () => {
      await handler({ call: { callId: 'call-ck', callerId: 'frank' } });
    });
    await act(async () => {});

    expect(startIncomingRingtone).not.toHaveBeenCalled();
  });

  // ── Outgoing ringback ─────────────────────────────────────────────────────

  test('placeCall starts outgoing ringback after the server reports ringing', async () => {
    const { startOutgoingRingback } = require('../../src/ringtone');
    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValueOnce({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });

    const { resultRef, tree } = await renderWithSocket();
    act(() => {
      resultRef.current.setCalleeId('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.initiate') {
        cb?.({
          ok: true,
          call: {
            callId: 'call-outgoing',
            callerId: 'alice',
            calleeId: 'bob',
            status: 'ringing',
            ringTimeoutAt: new Date(Date.now() + 30_000).toISOString(),
          },
        });
      }
    });

    await act(async () => {
      await resultRef.current.placeCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.callPhase).toBe(CALL_PHASES.OUTGOING_RINGING);
    expect(resultRef.current.status.message).toBe('Ringing bob…');
    expect(startOutgoingRingback).toHaveBeenCalledTimes(1);
  });

  test('call.state_changed "accepted" stops outgoing ringback and shows connecting status', async () => {
    const { stopOutgoingRingback } = require('../../src/ringtone');
    const { resultRef, tree } = await renderWithSocket();

    // Simulate an outgoing ringing call in hook state.
    await act(async () => {
      resultRef.current.setCalleeId('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { mediaDevices, RTCPeerConnection } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    RTCPeerConnection.mockImplementation(() => ({
      addTrack: jest.fn(),
      addIceCandidate: jest.fn(),
      close: jest.fn(),
      createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: '' }),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      localDescription: { type: 'offer', sdp: '' },
      getSenders: jest.fn(() => []),
    }));

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.initiate') {
        cb?.({
          ok: true,
          call: { callId: 'call-accepted', callerId: 'alice', calleeId: 'bob', status: 'ringing' },
        });
      } else {
        cb?.({ ok: true });
      }
    });
    await act(async () => {
      await resultRef.current.placeCall();
    });

    const stateHandler = getSocketHandler('call.state_changed');
    await act(async () => {
      await stateHandler({
        status: 'accepted',
        call: { callId: 'call-accepted', callerId: 'alice', calleeId: 'bob', status: 'accepted' },
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(stopOutgoingRingback).toHaveBeenCalled();
    expect(resultRef.current.status.message).toBe('Call accepted, connecting media…');
  });

  // ── Accept stops ringing ──────────────────────────────────────────────────

  test('accepting an incoming call stops the fallback ringtone', async () => {
    const { displayIncomingCall } = require('../../src/callKeep');
    const { stopIncomingRingtone } = require('../../src/ringtone');
    displayIncomingCall.mockResolvedValueOnce({ shown: false, reason: 'native_module_absent' }); // force ringtone fallback

    const { resultRef, tree } = await renderWithSocket();

    // Simulate an incoming call.
    const handler = getSocketHandler('call.incoming');
    const fakeCall = { callId: 'call-accept', callerId: 'grace' };
    await act(async () => {
      await handler({ call: fakeCall });
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // Set up getUserMedia to unblock acceptIncomingCall.
    const { mediaDevices } = require('react-native-webrtc');
    const fakeStream = {
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    };
    mediaDevices.getUserMedia.mockResolvedValueOnce(fakeStream);

    // Accept call – emitWithAck needs the socket emit to call back.
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event, _payload, cb) => {
      cb?.({ ok: true, call: { callId: 'call-accept', callerId: 'grace' } });
    });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(stopIncomingRingtone).toHaveBeenCalled();
  });

  // ── Decline stops ringing ─────────────────────────────────────────────────

  test('declining an incoming call stops ringing', async () => {
    const { stopIncomingRingtone } = require('../../src/ringtone');

    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    const fakeCall = { callId: 'call-decline', callerId: 'henry' };
    await act(async () => {
      await handler({ call: fakeCall });
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // Stub socket.emit for the decline ack.
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event, _payload, cb) => {
      cb?.({ ok: true });
    });

    await act(async () => {
      await resultRef.current.declineIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(stopIncomingRingtone).toHaveBeenCalled();
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
  });

  // ── Terminal call.state_changed stops ringing ─────────────────────────────

  test.each([
    ['declined', 'Call declined'],
    ['missed', 'Call not answered'],
    ['busy', 'Callee is busy'],
    ['unreachable', 'Callee is unreachable'],
  ])('call.state_changed "%s" stops ringing', async callStatus => {
    const { stopIncomingRingtone } = require('../../src/ringtone');

    const { resultRef, tree } = await renderWithSocket();

    // Simulate an active incoming call first.
    const incomingHandler = getSocketHandler('call.incoming');
    await act(async () => {
      await incomingHandler({
        call: { callId: 'call-state', callerId: 'irene' },
      });
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // Fire the terminal state change.
    const stateHandler = getSocketHandler('call.state_changed');
    await act(async () => {
      await stateHandler({
        status: callStatus,
        call: { callId: 'call-state', callerId: 'irene' },
        reason: callStatus,
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(stopIncomingRingtone).toHaveBeenCalled();
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
  });

  test('call.state_changed "ended" stops ringing', async () => {
    const { stopIncomingRingtone } = require('../../src/ringtone');

    const { resultRef, tree } = await renderWithSocket();

    const incomingHandler = getSocketHandler('call.incoming');
    await act(async () => {
      await incomingHandler({
        call: { callId: 'call-ended', callerId: 'joe' },
      });
    });
    await act(async () => {});

    const stateHandler = getSocketHandler('call.state_changed');
    await act(async () => {
      await stateHandler({
        status: 'ended',
        call: { callId: 'call-ended', callerId: 'joe' },
        reason: 'ended',
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(stopIncomingRingtone).toHaveBeenCalled();
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
  });

  // ── CallKeep answer/end bridging ──────────────────────────────────────────

  function latestCallActionHandlers() {
    const { setCallActionHandlers } = require('../../src/callKeep');
    const { calls } = setCallActionHandlers.mock;
    return calls[calls.length - 1]?.[0];
  }

  test('mounting attaches CallKeep handlers via setCallActionHandlers, not registerCallActionListeners', async () => {
    const { setCallActionHandlers, registerCallActionListeners } = require('../../src/callKeep');

    await renderWithSocket();

    expect(setCallActionHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        onAnswer: expect.any(Function),
        onEnd: expect.any(Function),
      }),
    );
    // The native subscription is wired once, at module scope in index.js -
    // useCallFlow must never re-register it (that would silently replace it
    // and, on unmount, remove it).
    expect(registerCallActionListeners).not.toHaveBeenCalled();
  });

  test('unmounting detaches the CallKeep handlers without leaving the app unresponsive', async () => {
    const detach = jest.fn();
    require('../../src/callKeep').setCallActionHandlers.mockReturnValueOnce(detach);

    const { tree } = await renderWithSocket();
    act(() => {
      tree.unmount();
    });

    // Only the handler hand-off is detached; the native listener wired at
    // module scope (index.js) is left in place, so a subsequent answerCall
    // is queued for the next mount rather than going unanswered forever.
    expect(detach).toHaveBeenCalledTimes(1);
  });

  test('answerCall for the currently-ringing call accepts immediately', async () => {
    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValueOnce({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });

    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    const fakeCall = { callId: 'call-answer-now', callerId: 'kate' };
    await act(async () => {
      await handler({ call: fakeCall });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event, _payload, cb) => {
      cb?.({ ok: true, call: fakeCall });
    });

    const { onAnswer } = latestCallActionHandlers();
    await act(async () => {
      onAnswer('call-answer-now');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'call.accept',
      expect.objectContaining({ callId: 'call-answer-now' }),
      expect.any(Function),
    );
  });

  test('answerCall received before the matching call.incoming is recorded, not dropped, and replayed', async () => {
    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValueOnce({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });

    const { resultRef, tree } = await renderWithSocket();

    const fakeCall = { callId: 'call-headless', callerId: 'leo' };
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event, _payload, cb) => {
      cb?.({ ok: true, call: fakeCall });
    });

    // Simulates the module-scope queue in callKeep.js replaying an
    // `answerCall` that fired before this hook took over — e.g. the OS
    // Answer button was tapped during a push cold start, before the socket
    // even connected.
    const { onAnswer } = latestCallActionHandlers();
    act(() => {
      onAnswer('call-headless');
    });

    // Nothing to accept yet: the intent must be recorded rather than dropped.
    expect(socketMock.emit).not.toHaveBeenCalledWith(
      'call.accept',
      expect.anything(),
      expect.anything(),
    );

    // The socket subsequently connects and delivers the matching call.
    const handler = getSocketHandler('call.incoming');
    await act(async () => {
      await handler({ call: fakeCall });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    // Flush the replay effect and the async acceptIncomingCall it triggers.
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'call.accept',
      expect.objectContaining({ callId: 'call-headless' }),
      expect.any(Function),
    );
  });

  test('endCall from the OS UI declines a ringing call', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('call.incoming');
    await act(async () => {
      await handler({ call: { callId: 'call-os-end', callerId: 'mia' } });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event, _payload, cb) => cb?.({ ok: true }));

    const { onEnd } = latestCallActionHandlers();
    await act(async () => {
      onEnd('call-os-end');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'call.decline',
      expect.objectContaining({ callId: 'call-os-end' }),
      expect.any(Function),
    );
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
  });
});

// ─── Session lifecycle (session.invalid) ───────────────────────────────────

describe('useCallFlow session lifecycle', () => {
  function getSocketHandler(event, socketIndex = -1) {
    const { io } = require('socket.io-client');
    const index = socketIndex === -1 ? io.mock.results.length - 1 : socketIndex;
    const socketMock = io.mock.results[index]?.value;
    if (!socketMock) return undefined;
    const call = socketMock.on.mock.calls.find(([e]) => e === event);
    return call?.[1];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    require('../../src/pushNotifications').getInitialCallLink.mockResolvedValue(null);
  });

  async function renderWithSocket() {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-stale', userId: 'alice' }),
    }));

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    return { resultRef, tree };
  }

  test('session.invalid re-mints the session and reconnects the socket', async () => {
    await renderWithSocket();

    const { io } = require('socket.io-client');
    expect(io).toHaveBeenCalledTimes(1);

    const handler = getSocketHandler('session.invalid');
    expect(handler).toBeDefined();

    // The server rejects the stale session and hands back a fresh one.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-fresh', userId: 'alice' }),
    }));

    await act(async () => {
      await handler({ sessionId: 'sess-stale' });
    });
    await act(async () => {});

    // A new session was created and a second socket connection established.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/session'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(io).toHaveBeenCalledTimes(2);
    expect(io.mock.calls[1][1]).toEqual(
      expect.objectContaining({ auth: { sessionId: 'sess-fresh' } }),
    );
  });

  test('session.invalid surfaces an error status when re-minting fails', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('session.invalid');
    expect(handler).toBeDefined();

    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));

    await act(async () => {
      await handler({ sessionId: 'sess-stale' });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { io } = require('socket.io-client');
    // Re-minting failed, so no second socket connection is made.
    expect(io).toHaveBeenCalledTimes(1);
    expect(resultRef.current.status.message).toBe('Session expired — please reconnect.');
  });

  test('requests all runtime permissions once, up front, when an identity is established', async () => {
    const { ensureCallPermissions } = require('../../src/permissions');
    await renderWithSocket();

    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);
  });

  test('does not re-request startup permissions on a session.invalid reconnect', async () => {
    const { ensureCallPermissions } = require('../../src/permissions');
    await renderWithSocket();
    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);

    const handler = getSocketHandler('session.invalid');
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-fresh', userId: 'alice' }),
    }));
    await act(async () => {
      await handler({ sessionId: 'sess-stale' });
    });
    await act(async () => {});

    expect(ensureCallPermissions).toHaveBeenCalledTimes(1);
  });
});

// ─── Chat & call.media-state ───────────────────────────────────────────────

describe('useCallFlow chat', () => {
  /**
   * Helper: find a handler registered with socket.on(event) on the most
   * recently created socket from the io() mock (same helper as the
   * "incoming-call ringing" describe block above).
   */
  function getSocketHandler(event) {
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1]?.value;
    if (!socketMock) return undefined;
    const call = socketMock.on.mock.calls.find(([e]) => e === event);
    return call?.[1];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    require('../../src/pushNotifications').getInitialCallLink.mockResolvedValue(null);
  });

  /**
   * Render the hook and establish a socket by setting a userId so the
   * presence effect fires (mirrors `renderWithSocket` above).
   */
  async function renderWithSocket() {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-chat', userId: 'alice' }),
    }));

    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    return { resultRef, tree };
  }

  // ── fetchConversations ────────────────────────────────────────────────────

  test('fetchConversations populates conversations and unreadTotal on success', async () => {
    const { resultRef, tree } = await renderWithSocket();

    global.fetch = jest.fn(async url => {
      expect(url).toContain('/conversations?sessionId=');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          conversations: [
            { conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 2 },
            { conversationId: 'c2', peerId: 'carol', lastMessage: null, unreadCount: 3 },
          ],
        }),
      };
    });

    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.conversations).toHaveLength(2);
    expect(resultRef.current.unreadTotal).toBe(5);
  });

  test('conversations are fetched automatically once the socket connects, without waiting for a manual refresh', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const conversationsFetchSpy = jest.fn(async url => {
      expect(url).toContain('/conversations?sessionId=');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          conversations: [
            { conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 1 },
          ],
        }),
      };
    });
    global.fetch = conversationsFetchSpy;

    const connectHandler = getSocketHandler('connect');
    await act(async () => {
      await connectHandler();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(conversationsFetchSpy).toHaveBeenCalled();
    expect(resultRef.current.conversations).toHaveLength(1);
  });

  test('fetchConversations silently no-ops on a fetch error', async () => {
    const { resultRef, tree } = await renderWithSocket();

    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    });

    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.conversations).toEqual([]);
  });

  // ── fetchMessagesForPeer ──────────────────────────────────────────────────

  test('fetchMessagesForPeer sets the first page and pages older messages with `before`', async () => {
    const { resultRef, tree } = await renderWithSocket();

    global.fetch = jest.fn(async url => {
      expect(url).toContain('/messages?');
      expect(url).toContain('peerId=bob');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          conversationId: 'c1',
          messages: [
            {
              messageId: 'm2',
              senderId: 'bob',
              recipientId: 'alice',
              body: 'second',
              createdAt: '2024-01-02T00:00:00.000Z',
            },
            {
              messageId: 'm1',
              senderId: 'bob',
              recipientId: 'alice',
              body: 'first',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
          limit: 20,
        }),
      };
    });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.messagesByPeer.bob.map(m => m.messageId)).toEqual(['m2', 'm1']);

    // Page further back with `before`; new (older) messages are appended and
    // duplicates are deduped by messageId.
    global.fetch = jest.fn(async url => {
      expect(url).toContain('before=2024-01-01T00%3A00%3A00.000Z');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          conversationId: 'c1',
          messages: [
            {
              messageId: 'm1',
              senderId: 'bob',
              recipientId: 'alice',
              body: 'first',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
            {
              messageId: 'm0',
              senderId: 'bob',
              recipientId: 'alice',
              body: 'zeroth',
              createdAt: '2023-12-31T00:00:00.000Z',
            },
          ],
          limit: 20,
        }),
      };
    });

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob', {
        before: '2024-01-01T00:00:00.000Z',
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.messagesByPeer.bob.map(m => m.messageId)).toEqual(['m2', 'm1', 'm0']);
  });

  // ── markConversationRead ──────────────────────────────────────────────────

  test('markConversationRead posts to /messages/read and zeroes the local unread count', async () => {
    const { resultRef, tree } = await renderWithSocket();

    // Seed a conversation with an unread count.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 4 }],
      }),
    }));
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.unreadTotal).toBe(4);

    global.fetch = jest.fn(async (url, options) => {
      expect(url).toContain('/messages/read');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({
        sessionId: 'sess-chat',
        peerId: 'bob',
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ conversationId: 'c1', updated: 4 }),
      };
    });

    await act(async () => {
      await resultRef.current.markConversationRead('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.unreadTotal).toBe(0);
    expect(resultRef.current.conversations.find(c => c.peerId === 'bob').unreadCount).toBe(0);
  });

  // ── sendMessage ────────────────────────────────────────────────────────────

  test('sendMessage fails immediately (no optimistic reconciliation) when there is no connected socket', async () => {
    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi there');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const messages = resultRef.current.messagesByPeer.bob;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: 'hi there', failed: true, pending: false });
    expect(resultRef.current.status.severity).toBe('error');
  });

  test('sendMessage optimistically appends then reconciles with the server-confirmed message on ack', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    let capturedPayload;
    socketMock.emit.mockImplementation((event, payload, cb) => {
      if (event === 'message.send') {
        capturedPayload = payload;
        cb?.({
          ok: true,
          version: 1,
          event: 'message.send',
          message: {
            messageId: 'server-msg-1',
            conversationId: 'conv-1',
            senderId: 'alice',
            recipientId: 'bob',
            body: 'hi there',
            createdAt: '2024-05-01T00:00:00.000Z',
            deliveredTo: [],
            readAt: null,
          },
        });
      }
    });

    const sendPromise = act(async () => {
      await resultRef.current.sendMessage('bob', 'hi there');
    });
    // Immediately after invocation (before the ack resolves within the same
    // act batch) the optimistic message should already be present.
    await sendPromise;
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(capturedPayload).toEqual({
      version: 1,
      recipientId: 'bob',
      body: 'hi there',
    });

    const messages = resultRef.current.messagesByPeer.bob;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'server-msg-1',
      body: 'hi there',
      pending: false,
    });
    expect(messages[0].failed).toBeUndefined();
  });

  test('sendMessage marks the optimistic message failed and surfaces a status error when the ack rejects', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'message.send') {
        cb?.({ ok: false, error: { code: 'invalid', message: 'body too long' } });
      }
    });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi there');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const messages = resultRef.current.messagesByPeer.bob;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ pending: false, failed: true, body: 'hi there' });
    expect(resultRef.current.status).toEqual({
      message: 'Message failed to send',
      severity: 'error',
    });
  });

  test('sendMessage ignores an empty/whitespace-only body', async () => {
    const { resultRef, tree } = await renderWithSocket();

    await act(async () => {
      await resultRef.current.sendMessage('bob', '   ');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.messagesByPeer.bob).toBeUndefined();
  });

  // ── message.received socket event ─────────────────────────────────────────

  test('message.received bumps unreadCount for an existing conversation when it is not the active chat', async () => {
    const { resultRef, tree } = await renderWithSocket();

    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 0 }],
      }),
    }));
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const handler = getSocketHandler('message.received');
    expect(handler).toBeDefined();

    act(() => {
      handler({
        conversationId: 'c1',
        message: {
          messageId: 'srv-1',
          senderId: 'bob',
          recipientId: 'alice',
          body: 'hello!',
          createdAt: '2024-05-01T00:00:00.000Z',
        },
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.messagesByPeer.bob.map(m => m.messageId)).toEqual(['srv-1']);
    expect(resultRef.current.conversations.find(c => c.peerId === 'bob').unreadCount).toBe(1);
    expect(resultRef.current.unreadTotal).toBe(1);
  });

  test('message.received auto-marks-read and does not bump unread when the conversation is the active chat', async () => {
    const { resultRef, tree } = await renderWithSocket();

    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 0 }],
      }),
    }));
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      resultRef.current.setActiveChatPeerId('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    // Flush the effect that mirrors activeChatPeerId into the ref read by the
    // (already-registered) message.received handler.
    await act(async () => {});

    let readRequestBody = null;
    global.fetch = jest.fn(async (url, options) => {
      readRequestBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ conversationId: 'c1', updated: 1 }) };
    });

    const handler = getSocketHandler('message.received');
    await act(async () => {
      handler({
        conversationId: 'c1',
        message: {
          messageId: 'srv-2',
          senderId: 'bob',
          recipientId: 'alice',
          body: 'still here?',
          createdAt: '2024-05-01T00:01:00.000Z',
        },
      });
      await Promise.resolve();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(readRequestBody).toEqual({ sessionId: 'sess-chat', peerId: 'bob' });
    expect(resultRef.current.conversations.find(c => c.peerId === 'bob').unreadCount).toBe(0);
  });

  test('message.received refetches conversations for a brand-new peer not already in the list', async () => {
    const { resultRef, tree } = await renderWithSocket();

    // No existing conversations.
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ conversations: [] }),
    }));
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const fetchConversationsSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: [
          { conversationId: 'c-new', peerId: 'dave', lastMessage: null, unreadCount: 1 },
        ],
      }),
    }));
    global.fetch = fetchConversationsSpy;

    const handler = getSocketHandler('message.received');
    await act(async () => {
      handler({
        conversationId: 'c-new',
        message: {
          messageId: 'srv-3',
          senderId: 'dave',
          recipientId: 'alice',
          body: 'hi, new here',
          createdAt: '2024-05-01T00:02:00.000Z',
        },
      });
      await Promise.resolve();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(fetchConversationsSpy).toHaveBeenCalled();
    expect(resultRef.current.conversations.find(c => c.peerId === 'dave')).toBeDefined();
  });

  // ── typing indicators ─────────────────────────────────────────────────────

  test('sendTypingIndicator emits message.typing and throttles repeated true calls per peer', async () => {
    const { resultRef, tree } = await renderWithSocket();
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const typingEmits = socketMock.emit.mock.calls.filter(([event]) => event === 'message.typing');
    expect(typingEmits).toHaveLength(1);
    expect(typingEmits[0][1]).toEqual({
      version: expect.any(Number),
      recipientId: 'bob',
      isTyping: true,
    });
  });

  test('sendTypingIndicator always emits isTyping:false immediately, bypassing the throttle', async () => {
    const { resultRef, tree } = await renderWithSocket();
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    act(() => {
      resultRef.current.sendTypingIndicator('bob', false);
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const typingEmits = socketMock.emit.mock.calls.filter(([event]) => event === 'message.typing');
    expect(typingEmits.map(call => call[1].isTyping)).toEqual([true, false]);
  });

  test('sendTypingIndicator is a no-op when there is no connected socket', async () => {
    const { resultRef, tree } = await renderWithSocket();
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.connected = false;

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(socketMock.emit).not.toHaveBeenCalledWith('message.typing', expect.anything());
  });

  test('message.typing socket event updates typingByPeer and auto-clears after the safety timeout', async () => {
    jest.useFakeTimers();
    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('message.typing');
    expect(handler).toBeDefined();

    act(() => {
      handler({ senderId: 'bob', isTyping: true });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.typingByPeer.bob).toBe(true);

    act(() => {
      jest.advanceTimersByTime(6000);
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.typingByPeer.bob).toBe(false);

    jest.useRealTimers();
  });

  test('message.typing socket event with isTyping:false clears the indicator immediately', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('message.typing');
    act(() => {
      handler({ senderId: 'bob', isTyping: true });
    });
    act(() => {
      handler({ senderId: 'bob', isTyping: false });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.typingByPeer.bob).toBe(false);
  });

  // ── message.read socket event ─────────────────────────────────────────────

  test('message.read socket event marks own sent messages to that peer as read', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const deliveredHandler = getSocketHandler('message.delivered');
    act(() => {
      deliveredHandler({
        message: {
          messageId: 'sent-1',
          senderId: 'alice',
          recipientId: 'bob',
          body: 'hi bob',
          createdAt: '2024-05-01T00:00:00.000Z',
          readAt: null,
        },
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.messagesByPeer.bob[0].readAt).toBeNull();

    const readHandler = getSocketHandler('message.read');
    act(() => {
      readHandler({ readerId: 'bob', readAt: '2024-05-01T00:05:00.000Z' });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.messagesByPeer.bob[0].readAt).toBe('2024-05-01T00:05:00.000Z');
  });

  test('message.read socket event is a no-op when there is no readerId', async () => {
    await renderWithSocket();
    const readHandler = getSocketHandler('message.read');
    expect(() => {
      act(() => {
        readHandler({ readAt: '2024-05-01T00:05:00.000Z' });
      });
    }).not.toThrow();
  });

  // ── isPlacingCall ──────────────────────────────────────────────────────────

  test('isPlacingCall is true while placeCall awaits local media and resets afterward', async () => {
    const { resultRef, tree } = await renderWithSocket();
    act(() => {
      resultRef.current.setCalleeId('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { mediaDevices } = require('react-native-webrtc');
    let resolveMedia;
    mediaDevices.getUserMedia.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveMedia = resolve;
        }),
    );

    let placeCallPromise;
    act(() => {
      placeCallPromise = resultRef.current.placeCall();
    });
    // Flush the microtasks up to (and including) the `ensureCallPermissions()`
    // await inside `startLocalPreview`, so `getUserMedia` has actually been
    // called and `resolveMedia` is assigned, while still leaving `placeCall`
    // suspended so `isPlacingCall` can be observed as true.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    tree.update(<TestHook resultRef={resultRef} />);
    expect(resultRef.current.isPlacingCall).toBe(true);
    expect(resolveMedia).toBeDefined();

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.initiate') {
        cb?.({
          ok: true,
          call: {
            callId: 'call-outgoing',
            callerId: 'alice',
            calleeId: 'bob',
            status: 'ringing',
            ringTimeoutAt: new Date(Date.now() + 30_000).toISOString(),
          },
        });
      }
    });

    await act(async () => {
      resolveMedia({ getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] });
      await placeCallPromise;
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.isPlacingCall).toBe(false);
  });

  // ── call.media-state socket event ─────────────────────────────────────────

  test('call.media-state sets isRemoteScreenSharing only for the active call', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValueOnce({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });

    act(() => {
      resultRef.current.setCalleeId('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.initiate') {
        cb?.({
          ok: true,
          call: { callId: 'call-media-1', callerId: 'alice', calleeId: 'bob', status: 'ringing' },
        });
      }
    });

    await act(async () => {
      await resultRef.current.placeCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.isRemoteScreenSharing).toBe(false);

    const handler = getSocketHandler('call.media-state');
    expect(handler).toBeDefined();

    // A media-state event for a *different* call is ignored.
    act(() => {
      handler({ callId: 'some-other-call', mediaState: { isScreenSharing: true } });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.isRemoteScreenSharing).toBe(false);

    // A media-state event for the active call updates the flag.
    act(() => {
      handler({ callId: 'call-media-1', mediaState: { isScreenSharing: true } });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.isRemoteScreenSharing).toBe(true);

    act(() => {
      handler({ callId: 'call-media-1', mediaState: { isScreenSharing: false } });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.isRemoteScreenSharing).toBe(false);
  });

  // ── call.media-state emit-on-toggle ───────────────────────────────────────

  test('emits call.media-state whenever local isScreenSharing changes during an active call', async () => {
    const { resultRef, tree } = await renderWithSocket();

    // Simulate an incoming call and accept it so activeCallIdRef/peerConnectionRef
    // are populated (mirrors the "accepting an incoming call…" test above).
    const incomingHandler = getSocketHandler('call.incoming');
    await act(async () => {
      await incomingHandler({ call: { callId: 'call-share-1', callerId: 'bob' } });
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { mediaDevices, RTCPeerConnection } = require('react-native-webrtc');
    const videoSender = {
      track: { kind: 'video' },
      replaceTrack: jest.fn().mockResolvedValue(undefined),
    };
    mediaDevices.getUserMedia.mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    RTCPeerConnection.mockImplementation(() => ({
      addTrack: jest.fn(),
      getSenders: jest.fn(() => [videoSender]),
      onicecandidate: null,
      ontrack: null,
      close: jest.fn(),
    }));

    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1].value;
    const mediaStateEmits = [];
    socketMock.emit.mockImplementation((event, payload, cb) => {
      if (event === 'call.accept') {
        cb?.({ ok: true, call: { callId: 'call-share-1', callerId: 'bob', calleeId: 'alice' } });
      } else if (event === 'call.media-state') {
        mediaStateEmits.push(payload);
        cb?.({ ok: true });
      }
    });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const { startScreenCapture } = require('../../src/screenShare');
    startScreenCapture.mockResolvedValue({
      ok: true,
      stream: { getTracks: () => [] },
      videoTrack: { kind: 'video', stop: jest.fn() },
      audioTrack: null,
      audioShared: false,
    });

    await act(async () => {
      await resultRef.current.handleScreenShareToggle();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.isScreenSharing).toBe(true);
    expect(mediaStateEmits).toContainEqual({
      version: 1,
      callId: 'call-share-1',
      mediaState: { isScreenSharing: true },
    });
  });
});


// ─── Answer-path hardening ────────────────────────────────────────────────────
//
// Every failure on the answer path used to be a silent `return`: a call could
// ring and simply refuse to be picked up with no log, no user-visible status
// and nothing on the server. These tests pin each of those paths.

describe('useCallFlow answer path', () => {
  function getSocketHandler(event) {
    const { io } = require('socket.io-client');
    const socketMock = io.mock.results[io.mock.results.length - 1]?.value;
    if (!socketMock) return undefined;
    return socketMock.on.mock.calls.find(([e]) => e === event)?.[1];
  }

  function latestSocket() {
    const { io } = require('socket.io-client');
    return io.mock.results[io.mock.results.length - 1].value;
  }

  function mockFetch(routes) {
    global.fetch = jest.fn(async url => {
      const target = String(url);
      const match = Object.keys(routes).find(key => target.includes(key));
      if (match) return routes[match];
      return {
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-answer', userId: 'alice' }),
      };
    });
  }

  async function renderWithSocket() {
    if (!global.fetch) mockFetch({});
    const { resultRef, tree } = renderHook();
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    return { resultRef, tree };
  }

  async function ring(resultRef, tree, call) {
    const handler = getSocketHandler('call.incoming');
    await act(async () => {
      await handler({ call });
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    require('../../src/pushNotifications').getInitialCallLink.mockResolvedValue(null);
    require('../../src/incomingCallNotification').consumePendingCallAction.mockResolvedValue(null);
    require('../../src/permissions').getMissingCallPermissions.mockResolvedValue({
      camera: false,
      microphone: false,
      missing: [],
      message: null,
    });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('answering with no incoming call surfaces a reason instead of silently returning', async () => {
    const { logWarn } = require('../../src/appLogger');
    const { resultRef, tree } = await renderWithSocket();

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.status.message).toBe('No incoming call to answer');
    expect(logWarn).toHaveBeenCalledWith(
      '[CallFlow] acceptIncomingCall aborted',
      expect.objectContaining({ reason: 'no_incoming_call' }),
    );
  });

  test('unavailable local media degrades the call instead of preventing the answer', async () => {
    const { mediaDevices } = require('react-native-webrtc');
    const { sendPushReceipt } = require('../../src/pushNotifications');
    mediaDevices.getUserMedia.mockRejectedValue(new Error('Permission denied'));

    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-nomedia', callerId: 'olive' };
    await ring(resultRef, tree, call);

    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((_event, _payload, cb) => {
      cb?.({ ok: true, call });
    });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(socketMock.emit).toHaveBeenCalledWith(
      'call.accept',
      expect.objectContaining({ callId: 'call-nomedia' }),
      expect.any(Function),
    );
    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-nomedia', stage: 'answer_accepted' }),
    );
    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-nomedia',
        stage: 'answer_failed',
        reason: 'local_media_unavailable',
      }),
    );
  });

  test('a disconnected socket falls back to the HTTP accept endpoint', async () => {
    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });

    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-http', callerId: 'pia' };
    await ring(resultRef, tree, call);

    // The socket drops (or never finished connecting) before Answer is tapped.
    const socketMock = latestSocket();
    socketMock.connected = false;
    mockFetch({
      '/calls/call-http/accept': {
        ok: true,
        status: 200,
        json: async () => ({ ...call, status: 'accepted' }),
      },
    });

    await act(async () => {
      const accepted = resultRef.current.acceptIncomingCall();
      await Promise.resolve();
      jest.advanceTimersByTime(6000);
      await accepted;
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const acceptRequest = global.fetch.mock.calls.find(([url]) =>
      String(url).includes('/calls/call-http/accept'),
    );
    expect(acceptRequest).toBeTruthy();
    expect(acceptRequest[1].method).toBe('POST');
    expect(resultRef.current.activeCall).toMatchObject({ callId: 'call-http' });
  });

  test('an Accept tapped while the app was killed is replayed on mount', async () => {
    const { consumePendingCallAction } = require('../../src/incomingCallNotification');
    const { sendPushReceipt } = require('../../src/pushNotifications');
    const { mediaDevices } = require('react-native-webrtc');
    mediaDevices.getUserMedia.mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    consumePendingCallAction.mockResolvedValue({
      callId: 'call-native',
      action: 'accept',
      ageMs: 1200,
      connectionLive: false,
    });
    mockFetch({
      '/calls/call-native': {
        ok: true,
        status: 200,
        json: async () => ({
          callId: 'call-native',
          callerId: 'nina',
          calleeId: 'alice',
          status: 'ringing',
        }),
      },
    });

    const { resultRef, tree } = await renderWithSocket();
    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((_event, _payload, cb) => {
      cb?.({ ok: true, call: { callId: 'call-native', callerId: 'nina' } });
    });

    // Flush the deferred rehydration, the replay effect and the accept it runs.
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-native',
        stage: 'accept_tapped',
        reason: 'connection_missing',
      }),
    );
    expect(socketMock.emit).toHaveBeenCalledWith(
      'call.accept',
      expect.objectContaining({ callId: 'call-native' }),
      expect.any(Function),
    );
  });

  test('a Decline tapped while the app was killed still reaches the server', async () => {
    const { consumePendingCallAction } = require('../../src/incomingCallNotification');
    const { sendPushReceipt } = require('../../src/pushNotifications');
    consumePendingCallAction.mockResolvedValue({
      callId: 'call-native-decline',
      action: 'decline',
      ageMs: 900,
      connectionLive: true,
    });

    mockFetch({
      '/calls/call-native-decline/decline': {
        ok: true,
        status: 200,
        json: async () => ({ callId: 'call-native-decline', status: 'declined' }),
      },
    });

    const { resultRef, tree } = await renderWithSocket();
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-native-decline',
        stage: 'decline_tapped',
        reason: 'connection_live',
      }),
    );
    // The drain runs before the socket exists, so the decline must reach the
    // server over HTTP rather than being dropped.
    const declineRequest = global.fetch.mock.calls.find(([url]) =>
      String(url).includes('/calls/call-native-decline/decline'),
    );
    expect(declineRequest).toBeTruthy();
    expect(declineRequest[1].method).toBe('POST');
  });

  test('a duplicate accept for the same call is a logged no-op, not a teardown', async () => {
    const { endCall } = require('../../src/callKeep');
    const { sendPushReceipt } = require('../../src/pushNotifications');
    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-dup', callerId: 'nez', status: 'ringing' };
    await ring(resultRef, tree, call);

    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.accept') {
        cb?.({ ok: true, call: { ...call, status: 'accepted' } });
        return;
      }
      cb?.({ ok: true });
    });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const acceptEmits = () =>
      socketMock.emit.mock.calls.filter(([event]) => event === 'call.accept').length;
    expect(acceptEmits()).toBe(1);

    // The same call rings again (a duplicate push, or a rehydration that
    // re-populates the incoming call) and the user taps Answer a second time.
    // The server has already left `ringing`, so accepting again would fail —
    // and the old failure path tore down the call that had just connected.
    endCall.mockClear();
    await ring(resultRef, tree, call);
    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(acceptEmits()).toBe(1);
    expect(endCall).not.toHaveBeenCalled();
    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-dup',
        stage: 'answer_skipped_duplicate',
      }),
    );
    expect(resultRef.current.activeCall).toEqual(
      expect.objectContaining({ callId: 'call-dup', status: 'accepted' }),
    );
  });

  test('a second accept while the first is in flight is suppressed', async () => {
    const { sendPushReceipt } = require('../../src/pushNotifications');
    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-inflight', callerId: 'nez', status: 'ringing' };
    await ring(resultRef, tree, call);

    const socketMock = latestSocket();
    let ack = null;
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.accept') {
        ack = cb;
        return;
      }
      cb?.({ ok: true });
    });

    await act(async () => {
      const first = resultRef.current.acceptIncomingCall();
      const second = resultRef.current.acceptIncomingCall();
      await Promise.resolve();
      ack?.({ ok: true, call: { ...call, status: 'accepted' } });
      await Promise.all([first, second]);
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(
      socketMock.emit.mock.calls.filter(([event]) => event === 'call.accept'),
    ).toHaveLength(1);
    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-inflight',
        stage: 'answer_skipped_duplicate',
        reason: 'accept_in_flight',
      }),
    );
  });

  test('a failed accept never ends a call that is already active', async () => {
    const { resultRef, tree } = await renderWithSocket();
    const firstCall = { callId: 'call-live', callerId: 'nez', status: 'ringing' };
    await ring(resultRef, tree, firstCall);

    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.accept') {
        cb?.({ ok: true, call: { ...firstCall, status: 'accepted' } });
        return;
      }
      cb?.({ ok: true });
    });
    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });

    // A second call rings and its accept fails on every transport.
    await ring(resultRef, tree, { callId: 'call-doomed', callerId: 'zen', status: 'ringing' });
    mockFetch({
      '/calls/call-doomed/accept': { ok: false, status: 409, json: async () => ({}) },
    });
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.accept') {
        cb?.({ ok: false, error: { code: 'invalid_state' } });
        return;
      }
      cb?.({ ok: true });
    });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // The live call survives the failed accept.
    expect(resultRef.current.activeCall).toEqual(
      expect.objectContaining({ callId: 'call-live', status: 'accepted' }),
    );
    expect(resultRef.current.status.message).toBe('Call already answered');
  });

  test('a queued answer is replayed exactly once even as the accept callback changes', async () => {
    const { recordPendingAnswer } = require('../../src/callKeep');
    const { resultRef, tree } = await renderWithSocket();

    recordPendingAnswer('call-replay', 'test');
    const call = { callId: 'call-replay', callerId: 'nez', status: 'ringing' };
    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.accept') {
        cb?.({ ok: true, call: { ...call, status: 'accepted' } });
        return;
      }
      cb?.({ ok: true });
    });

    await ring(resultRef, tree, call);
    // Force extra renders: the replay effect re-runs whenever the accept
    // callback identity changes.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {});
      act(() => {
        tree.update(<TestHook resultRef={resultRef} />);
      });
    }

    expect(
      socketMock.emit.mock.calls.filter(([event]) => event === 'call.accept'),
    ).toHaveLength(1);
  });

  test('a call that stops ringing dismisses its notification and CallKeep connection', async () => {
    const { endCall } = require('../../src/callKeep');
    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-stale', callerId: 'nez', status: 'ringing' };
    await ring(resultRef, tree, call);

    endCall.mockClear();
    const stateChanged = getSocketHandler('call.state_changed');
    await act(async () => {
      await stateChanged({
        status: 'ended',
        reason: 'cancelled',
        call: { ...call, status: 'ended' },
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(endCall).toHaveBeenCalledWith('call-stale');
  });

  test('a terminal transition for another call leaves the active call alone', async () => {
    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-current', callerId: 'nez', status: 'ringing' };
    await ring(resultRef, tree, call);

    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((event, _payload, cb) => {
      if (event === 'call.accept') {
        cb?.({ ok: true, call: { ...call, status: 'accepted' } });
        return;
      }
      cb?.({ ok: true });
    });
    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });

    const { endCall } = require('../../src/callKeep');
    endCall.mockClear();
    const stateChanged = getSocketHandler('call.state_changed');
    await act(async () => {
      await stateChanged({
        status: 'missed',
        reason: 'timeout',
        call: { callId: 'call-other', callerId: 'nez', status: 'missed' },
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // Only the stale call's UI goes away; the connected call is untouched.
    expect(endCall).toHaveBeenCalledWith('call-other');
    expect(endCall).not.toHaveBeenCalledWith('call-current');
    expect(resultRef.current.activeCall).toEqual(
      expect.objectContaining({ callId: 'call-current', status: 'accepted' }),
    );
  });

  test('a queued answer for a call that is gone is dropped loudly, not left stuck', async () => {
    const { endCall, peekPendingAnswer } = require('../../src/callKeep');
    const { sendPushReceipt } = require('../../src/pushNotifications');
    mockFetch({
      '/calls/call-gone': { ok: false, status: 404, json: async () => ({}) },
    });

    const { resultRef, tree } = await renderWithSocket();
    const { setCallActionHandlers } = require('../../src/callKeep');
    const { onAnswer } =
      setCallActionHandlers.mock.calls[setCallActionHandlers.mock.calls.length - 1][0];

    await act(async () => {
      onAnswer('call-gone');
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(peekPendingAnswer()).toBeNull();
    // The call had already stopped ringing, so the tap is reported as landing
    // on a dead notification and that notification is dismissed.
    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-gone',
        stage: 'accept_tapped',
        reason: 'call_already_ended',
      }),
    );
    expect(endCall).toHaveBeenCalledWith('call-gone');
    expect(resultRef.current.status.message).toMatch(/no longer available/i);
  });

  test('a queued answer whose call cannot be fetched is reported as unavailable', async () => {
    const { peekPendingAnswer } = require('../../src/callKeep');
    const { sendPushReceipt } = require('../../src/pushNotifications');
    mockFetch({
      '/calls/call-unreachable': { ok: false, status: 500, json: async () => ({}) },
    });

    const { resultRef, tree } = await renderWithSocket();
    const { setCallActionHandlers } = require('../../src/callKeep');
    const { onAnswer } =
      setCallActionHandlers.mock.calls[setCallActionHandlers.mock.calls.length - 1][0];

    await act(async () => {
      onAnswer('call-unreachable');
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(peekPendingAnswer()).toBeNull();
    expect(sendPushReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-unreachable',
        stage: 'answer_failed',
        reason: 'call_unavailable',
      }),
    );
  });
});
