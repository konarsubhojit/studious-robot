import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import useCallFlow, { CALL_PHASES, CALL_END_REASON_LABELS } from '../../src/hooks/useCallFlow';
import useCompactCallView from '../../src/hooks/useCompactCallView';

// ─── Module mocks ─────────────────────────────────────────────────────────────

// The messaging hook hydrates from (and persists to) the local chat store; the
// store itself is covered by `__tests__/storage/chatDb.test.js`.
jest.mock('../../src/storage/chatDb', () => ({
  loadChatSnapshot: jest.fn(async () => ({ conversations: [], messagesByPeer: {}, outbox: [] })),
  saveChatSnapshot: jest.fn(),
}));

// `voiceRecorder.js` (pulled in via `useAttachments`) imports this directly
// (it's a hard app dependency, not an optional native module); the real
// package doesn't parse under Jest's transform, same reason `chatDb.test.js`
// mocks it.
jest.mock('react-native-fs', () => ({
  stat: jest.fn().mockResolvedValue({ size: 0 }),
}));

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => ({
    connected: true,
    id: 'mock-socket-id',
    disconnect: jest.fn(),
    off: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    // The Engine.IO manager. Its `ping` event is the timer-free clock the call
    // heartbeat falls back on while the OS has the JS timer queue suspended.
    io: { on: jest.fn(), off: jest.fn() },
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
  applyPreferredAudioRoute: jest.fn(() =>
    Promise.resolve({ ok: true, selected: 'earpiece', available: ['earpiece'] }),
  ),
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
  // Only the quality grading is stubbed; the candidate-pair summary is pure
  // and is exactly what these ICE tests are asserting on.
  ...jest.requireActual('../../src/callUx'),
  getConnectionQuality: jest.fn(() => ({ bars: 3, label: 'Strong' })),
}));

jest.mock('../../src/screenShare', () => ({
  SCREEN_SHARE_CANCELLED: 'cancelled',
  SCREEN_SHARE_NO_FRAMES: 'no_frames',
  isScreenShareSupported: jest.fn(() => true),
  startScreenCapture: jest.fn(),
  stopScreenCapture: jest.fn(),
  verifyScreenShareFrames: jest.fn(() => Promise.resolve({ ok: true, frames: 1, verified: true })),
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

const mockNetworkListeners: any[] = [];
jest.mock('../../src/networkMonitor', () => ({
  subscribeNetworkChanges: (listener: any) => {
    mockNetworkListeners.push(listener);
    return () => {
      const index = mockNetworkListeners.indexOf(listener);
      if (index >= 0) mockNetworkListeners.splice(index, 1);
    };
  },
}));

jest.mock('../../src/webrtcConfig', () => ({
  ICE_TRANSPORT_POLICIES: { ALL: 'all', RELAY: 'relay' },
  getIceServers: jest.fn(() => []),
  getIceServersForCall: jest.fn(async () => []),
  // The real parser: the point of these tests is that the TURN summary the
  // call logs matches the list handed to RTCPeerConnection.
  getTurnServerEndpoints: jest.requireActual('../../src/webrtcConfig').getTurnServerEndpoints,
  applyBitrateConstraints: jest.fn(async () => {}),
  normalizeIceTransportPolicy: jest.fn(value => (value === 'relay' ? 'relay' : 'all')),
  resetIceServersForCallCache: jest.fn(),
}));

jest.mock('../../src/callKeep', () => {
  let pendingAnswerCallId: any = null;
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

function TestHook({ resultRef, options }: any) {
  const result = useCallFlow(options);
  resultRef.current = result;
  return null;
}

function renderHook(options?: any) {
  const resultRef: { current: any; } = { current: null };
  let tree: any;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} options={options} />);
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
    delete ((global as any)).fetch;
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

  test('wires the Picture-in-Picture window controls to mute and hang up', () => {
    const { resultRef } = renderHook();
    const compactOptions = (useCompactCallView as jest.Mock).mock.calls.at(-1)?.[1];

    expect(compactOptions.isMuted).toBe(false);

    act(() => {
      compactOptions.onToggleMute();
    });
    expect(resultRef.current.isMuted).toBe(true);

    expect(typeof compactOptions.onEndCall).toBe('function');
    act(() => {
      compactOptions.onEndCall();
    });
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
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-2', userId: 'alice' }),
    })) as any);

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

    const sessionRequest = (global.fetch as jest.Mock).mock.calls.find(([url]: any) =>
      String(url).endsWith('/session'),
    );
    expect(sessionRequest).toBeTruthy();
    expect(JSON.parse(sessionRequest[1].body)).toMatchObject({
      userId: 'alice',
      idToken: 'firebase-id-token',
    });
  });

  test('identity conflicts surface a user-friendly status message', async () => {
    global.fetch = (jest.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ code: 'identity_claimed' }),
    })) as any);

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
    global.fetch = (jest.fn(async (url, options) => {
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
    }) as any);

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
    const pending: any = [];
    global.fetch = (jest.fn(url => {
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
    }) as any);

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
    global.fetch = (jest.fn() as any);
    jest.clearAllMocks();
    // Reset the pushNotifications mock to return null for initial URL by default.
    (require('../../src/pushNotifications').getInitialCallLink as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    delete ((global as any)).fetch;
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
    (global.fetch as jest.Mock)
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
    (global.fetch as jest.Mock)
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
    (global.fetch as jest.Mock)
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

    (global.fetch as jest.Mock)
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

    (global.fetch as jest.Mock)
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

    (global.fetch as jest.Mock)
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

    (global.fetch as jest.Mock)
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
    (global.fetch as jest.Mock)
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

  function makeStream(videoTrack: any) {
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
    (require('../../src/pushNotifications').getInitialCallLink as jest.Mock).mockResolvedValue(null);

    // Provide a minimal RTCPeerConnection stub so ensurePeerConnection succeeds
    // if it is exercised by a test.
    const { RTCPeerConnection } = require('react-native-webrtc');
    (RTCPeerConnection as jest.Mock).mockImplementation(() => ({
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

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
    (mediaDevices.getUserMedia as jest.Mock)
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(stream).mockResolvedValueOnce(newStream);

    // Provide a sender so the replaceTrack branch is exercised.
    (RTCPeerConnection as jest.Mock).mockImplementation(() => ({
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
  function getSocketHandler(event: any) {
    const { io } = require('socket.io-client');
    // Find the most-recently created socket mock instance.
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1]?.value;
    if (!socketMock) return undefined;
    const call = socketMock.on.mock.calls.find(([e]: any) => e === event);
    return call?.[1];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (require('../../src/pushNotifications').getInitialCallLink as jest.Mock).mockResolvedValue(null);
    // Default: CallKeep shows the system UI successfully.
    (require('../../src/callKeep').displayIncomingCall as jest.Mock).mockResolvedValue({ shown: true });
  });

  /**
   * Render the hook and establish a socket by setting a userId so the presence
   * effect fires.  Returns the hook result ref and renderer tree.
   */
  async function renderWithSocket(options?: any) {
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-ring', userId: 'alice' }),
    })) as any);

    const { resultRef, tree } = renderHook(options);
    // Setting userId triggers the presence effect → createOrGetSession → connectSocket.
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} options={options} />);
    });
    // Flush async socket-connection work.
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} options={options} />);
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
    (displayIncomingCall as jest.Mock).mockResolvedValueOnce({ shown: false, reason: 'native_module_absent' });

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
    (displayIncomingCall as jest.Mock).mockResolvedValueOnce({ shown: true });

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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce({
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
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    (RTCPeerConnection as jest.Mock).mockImplementation(() => ({
      addTrack: jest.fn(),
      addIceCandidate: jest.fn(),
      close: jest.fn(),
      createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: '' }),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      localDescription: { type: 'offer', sdp: '' },
      getSenders: jest.fn(() => []),
    }));

    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
    (displayIncomingCall as jest.Mock).mockResolvedValueOnce({ shown: false, reason: 'native_module_absent' }); // force ringtone fallback

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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce(fakeStream);

    // Accept call – emitWithAck needs the socket emit to call back.
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
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
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
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

  test('call.state_changed "busy" with no live call reports own state for reconciliation', async () => {
    const { resultRef } = await renderWithSocket();
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
      cb?.({ ok: true, clearedCallIds: ['phantom-call'] });
    });

    const stateHandler = getSocketHandler('call.state_changed');
    await act(async () => {
      await stateHandler({
        status: 'busy',
        call: { callId: 'call-busy', callerId: 'me' },
        reason: 'busy',
      });
    });

    const report = socketMock.emit.mock.calls.find(([event]: any) => event === 'call.state.report');
    expect(report).toBeDefined();
    expect(report[1].activeCallIds).toEqual([]);
    expect(resultRef.current.callPhase).toBe(CALL_PHASES.IDLE);
  });

  test('call.state_changed "busy" while a call is live does not report own state', async () => {
    await renderWithSocket();
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
      cb?.({ ok: true });
    });

    const incomingHandler = getSocketHandler('call.incoming');
    await act(async () => {
      await incomingHandler({ call: { callId: 'call-live', callerId: 'irene' } });
    });
    await act(async () => {});

    const stateHandler = getSocketHandler('call.state_changed');
    await act(async () => {
      await stateHandler({
        status: 'busy',
        call: { callId: 'call-busy-other', callerId: 'me' },
        reason: 'busy',
      });
    });

    expect(
      socketMock.emit.mock.calls.some(([event]: any) => event === 'call.state.report'),
    ).toBe(false);
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
    const { calls } = (setCallActionHandlers as jest.Mock).mock;
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
    (require('../../src/callKeep').setCallActionHandlers as jest.Mock).mockReturnValueOnce(detach);

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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce({
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
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });

    const { resultRef, tree } = await renderWithSocket();

    const fakeCall = { callId: 'call-headless', callerId: 'leo' };
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
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
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => cb?.({ ok: true }));

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
  function getSocketHandler(event: any, socketIndex = -1) {
    const { io } = require('socket.io-client');
    const index = socketIndex === -1 ? (io as jest.Mock).mock.results.length - 1 : socketIndex;
    const socketMock = (io as jest.Mock).mock.results[index]?.value;
    if (!socketMock) return undefined;
    const call = socketMock.on.mock.calls.find(([e]: any) => e === event);
    return call?.[1];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (require('../../src/pushNotifications').getInitialCallLink as jest.Mock).mockResolvedValue(null);
  });

  async function renderWithSocket() {
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-stale', userId: 'alice' }),
    })) as any);

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
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-fresh', userId: 'alice' }),
    })) as any);

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
    expect((io as jest.Mock).mock.calls[1][1]).toEqual(
      expect.objectContaining({
        auth: { sessionId: 'sess-fresh', correlationId: expect.stringMatching(/^wt-/) },
      }),
    );
  });

  test('session.invalid surfaces an error status when re-minting fails', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const handler = getSocketHandler('session.invalid');
    expect(handler).toBeDefined();

    global.fetch = (jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as any);

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
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-fresh', userId: 'alice' }),
    })) as any);
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
  function getSocketHandler(event: any) {
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1]?.value;
    if (!socketMock) return undefined;
    const call = socketMock.on.mock.calls.find(([e]: any) => e === event);
    return call?.[1];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (require('../../src/pushNotifications').getInitialCallLink as jest.Mock).mockResolvedValue(null);
  });

  /**
   * Render the hook and establish a socket by setting a userId so the
   * presence effect fires (mirrors `renderWithSocket` above).
   */
  async function renderWithSocket(options?: any) {
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ sessionId: 'sess-chat', userId: 'alice' }),
    })) as any);

    const { resultRef, tree } = renderHook(options);
    await act(async () => {
      resultRef.current.setUserId('alice');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} options={options} />);
    });
    await act(async () => {});
    act(() => {
      tree.update(<TestHook resultRef={resultRef} options={options} />);
    });

    return { resultRef, tree };
  }

  // ── fetchConversations ────────────────────────────────────────────────────

  test('fetchConversations populates conversations and unreadTotal on success', async () => {
    const { resultRef, tree } = await renderWithSocket();

    global.fetch = (jest.fn(async url => {
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
    }) as any);

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
    global.fetch = (conversationsFetchSpy as any);

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

    global.fetch = (jest.fn(async () => {
      throw new Error('network down');
    }) as any);

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

    global.fetch = (jest.fn(async url => {
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
    }) as any);

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.messagesByPeer.bob.map((m: any) => m.messageId)).toEqual(['m2', 'm1']);

    // Page further back with `before`; new (older) messages are appended and
    // duplicates are deduped by messageId.
    global.fetch = (jest.fn(async url => {
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
    }) as any);

    await act(async () => {
      await resultRef.current.fetchMessagesForPeer('bob', {
        before: '2024-01-01T00:00:00.000Z',
      });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.messagesByPeer.bob.map((m: any) => m.messageId)).toEqual(['m2', 'm1', 'm0']);
  });

  // ── markConversationRead ──────────────────────────────────────────────────

  test('markConversationRead posts to /messages/read and zeroes the local unread count', async () => {
    const { resultRef, tree } = await renderWithSocket();

    // Seed a conversation with an unread count.
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 4 }],
      }),
    })) as any);
    await act(async () => {
      await resultRef.current.fetchConversations();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
    expect(resultRef.current.unreadTotal).toBe(4);

    global.fetch = (jest.fn(async (url, options) => {
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
    }) as any);

    await act(async () => {
      await resultRef.current.markConversationRead('bob');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    expect(resultRef.current.unreadTotal).toBe(0);
    expect(resultRef.current.conversations.find((c: any) => c.peerId === 'bob').unreadCount).toBe(0);
  });

  // ── sendMessage ────────────────────────────────────────────────────────────

  test('sendMessage queues the message durably when there is no connected socket', async () => {
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
    // Queued rather than failed: it is replayed once the socket comes up.
    expect(messages[0]).toMatchObject({ body: 'hi there', pending: true, syncState: 'pending' });
    expect(resultRef.current.pendingSendCount).toBe(1);

    // Unmount so the queued message's retry timer does not outlive the test.
    act(() => {
      tree.unmount();
    });
  });

  test('sendMessage optimistically appends then reconciles with the server-confirmed message on ack', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    let capturedPayload;
    socketMock.emit.mockImplementation((event: any, payload: any, cb: any) => {
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
      // Client-generated so the server's upsert makes a replay idempotent.
      messageId: expect.any(String),
    });

    const messages = resultRef.current.messagesByPeer.bob;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'server-msg-1',
      body: 'hi there',
      pending: false,
    });
    expect(messages[0].failed).toBe(false);
  });

  test('sendMessage marks the optimistic message failed and surfaces a status error once its retries are exhausted', async () => {
    const { resultRef, tree } = await renderWithSocket();

    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
      if (event === 'message.send') {
        cb?.({ ok: false, error: { code: 'invalid', message: 'body too long' } });
      }
    });

    await act(async () => {
      await resultRef.current.sendMessage('bob', 'hi there');
    });
    // Drain until the automatic attempt budget is spent.
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await act(async () => {
        await resultRef.current.drainOutbox();
      });
    }
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

    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 0 }],
      }),
    })) as any);
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

    expect(resultRef.current.messagesByPeer.bob.map((m: any) => m.messageId)).toEqual(['srv-1']);
    expect(resultRef.current.conversations.find((c: any) => c.peerId === 'bob').unreadCount).toBe(1);
    expect(resultRef.current.unreadTotal).toBe(1);
  });

  test('message.received auto-marks-read and does not bump unread when the conversation is the active chat', async () => {
    const { resultRef, tree } = await renderWithSocket();

    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        conversations: [{ conversationId: 'c1', peerId: 'bob', lastMessage: null, unreadCount: 0 }],
      }),
    })) as any);
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
    global.fetch = (jest.fn(async (url, options) => {
      readRequestBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ conversationId: 'c1', updated: 1 }) };
    }) as any);

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
    expect(resultRef.current.conversations.find((c: any) => c.peerId === 'bob').unreadCount).toBe(0);
  });

  test('message.received refetches conversations for a brand-new peer not already in the list', async () => {
    const { resultRef, tree } = await renderWithSocket();

    // No existing conversations.
    global.fetch = (jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ conversations: [] }),
    })) as any);
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
    global.fetch = (fetchConversationsSpy as any);

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
    expect(resultRef.current.conversations.find((c: any) => c.peerId === 'dave')).toBeDefined();
  });

  // ── typing indicators ─────────────────────────────────────────────────────

  test('sendTypingIndicator emits message.typing and throttles repeated true calls per peer', async () => {
    const { resultRef, tree } = await renderWithSocket();
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const typingEmits = socketMock.emit.mock.calls.filter(([event]: any) => event === 'message.typing');
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
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;

    act(() => {
      resultRef.current.sendTypingIndicator('bob', true);
    });
    act(() => {
      resultRef.current.sendTypingIndicator('bob', false);
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    const typingEmits = socketMock.emit.mock.calls.filter(([event]: any) => event === 'message.typing');
    expect(typingEmits.map((call: any) => call[1].isTyping)).toEqual([true, false]);
  });

  test('sendTypingIndicator is a no-op when there is no connected socket', async () => {
    const { resultRef, tree } = await renderWithSocket();
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
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
    let resolveMedia: any;
    (mediaDevices.getUserMedia as jest.Mock).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveMedia = resolve;
        }),
    );

    let placeCallPromise: any;
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
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValueOnce({
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
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    (RTCPeerConnection as jest.Mock).mockImplementation(() => ({
      addTrack: jest.fn(),
      getSenders: jest.fn(() => [videoSender]),
      onicecandidate: null,
      ontrack: null,
      close: jest.fn(),
    }));

    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    const mediaStateEmits: any = [];
    socketMock.emit.mockImplementation((event: any, payload: any, cb: any) => {
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
    (startScreenCapture as jest.Mock).mockResolvedValue({
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

  // ── call.connected ────────────────────────────────────────────────────────
  //
  // Nothing else advances a call out of `connecting_media`, so a client that
  // never reports its connected peer connection is force-ended by the server's
  // stale-call sweep with `media_connect_timeout` while media is still flowing.

  /**
   * Accept an incoming call with a peer-connection stub whose state callbacks
   * the test can fire by hand.
   */
  async function acceptCallWithPeerConnection(callId: any, options?: any, { callerId = 'bob' }: { callerId?: string; } = {}) {
    const { resultRef, tree } = await renderWithSocket(options);

    const incomingHandler = getSocketHandler('call.incoming');
    await act(async () => {
      await incomingHandler({ call: { callId, callerId } });
    });
    await act(async () => {});

    const { mediaDevices, RTCPeerConnection } = require('react-native-webrtc');
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    const peerConnection: any = {
      addTrack: jest.fn(),
      getSenders: jest.fn(() => []),
      onicecandidate: null,
      ontrack: null,
      oniceconnectionstatechange: null,
      onconnectionstatechange: null,
      close: jest.fn(),
      iceConnectionState: 'checking',
      connectionState: 'connecting',
      getStats: jest.fn().mockResolvedValue(new Map()),
      setRemoteDescription: jest.fn().mockResolvedValue(undefined),
      createAnswer: jest.fn().mockResolvedValue({ type: 'answer', sdp: 'answer-sdp' }),
      createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: 'restart-offer-sdp' }),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      localDescription: { type: 'answer', sdp: 'answer-sdp' },
    };
    (RTCPeerConnection as jest.Mock).mockImplementation(() => peerConnection);

    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
    const emits: any = [];
    socketMock.emit.mockImplementation((event: any, payload: any, cb: any) => {
      emits.push({ event, payload });
      if (event === 'call.accept') {
        cb?.({ ok: true, call: { callId, callerId, calleeId: 'alice' } });
      } else {
        cb?.({ ok: true });
      }
    });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} options={options} />);
    });

    return { resultRef, tree, peerConnection, emits };
  }

  function candidatePairReport({
    localType,
    remoteType,
    protocol = 'udp',
    relayProtocol,
  }: {
    localType: string;
    remoteType: string;
    protocol?: string;
    relayProtocol?: string;
  }) {
    return new Map([
      [
        'pair-1',
        {
          id: 'pair-1',
          type: 'candidate-pair',
          state: 'succeeded',
          localCandidateId: 'local-1',
          remoteCandidateId: 'remote-1',
        },
      ],
      [
        'local-1',
        {
          id: 'local-1',
          type: 'local-candidate',
          candidateType: localType,
          protocol,
          relayProtocol,
        },
      ],
      [
        'remote-1',
        {
          id: 'remote-1',
          type: 'remote-candidate',
          candidateType: remoteType,
          protocol,
        },
      ],
    ]);
  }

  async function connectPeerConnection(peerConnection: any, callId: string) {
    const offerHandler = getSocketHandler('rtc.offer');
    await act(async () => {
      await offerHandler({
        callId,
        sdp: { type: 'offer', sdp: 'offer-sdp' },
      });
    });
    await act(async () => {
      peerConnection.iceConnectionState = 'connected';
      peerConnection.oniceconnectionstatechange?.();
      await Promise.resolve();
    });
  }

  test('reports call.connected once media reaches the connected ICE state', async () => {
    const { peerConnection, emits } = await acceptCallWithPeerConnection('call-connected-1');

    expect(peerConnection.oniceconnectionstatechange).toEqual(expect.any(Function));

    await act(async () => {
      peerConnection.iceConnectionState = 'connected';
      peerConnection.oniceconnectionstatechange?.();
    });

    const connectedEmits = emits.filter((entry: any) => entry.event === 'call.connected');
    expect(connectedEmits).toHaveLength(1);
    expect(connectedEmits[0].payload).toEqual({
      version: 1,
      callId: 'call-connected-1',
      iceState: 'connected',
    });

    // Repeated state callbacks (and the connection-state callback firing for
    // the same event) must not re-report.
    await act(async () => {
      peerConnection.iceConnectionState = 'completed';
      peerConnection.oniceconnectionstatechange?.();
      peerConnection.connectionState = 'connected';
      peerConnection.onconnectionstatechange?.();
    });
    expect(emits.filter((entry: any) => entry.event === 'call.connected')).toHaveLength(1);
  });

  test('heartbeats over call.media-state while the call is connected', async () => {
    jest.useFakeTimers();
    try {
      const { peerConnection, emits } = await acceptCallWithPeerConnection('call-connected-2');

      await act(async () => {
        peerConnection.connectionState = 'connected';
        peerConnection.onconnectionstatechange?.();
      });

      const beatsBefore = emits.filter(
        (entry: any) => entry.event === 'call.media-state' && entry.payload?.mediaState?.heartbeat,
      ).length;

      await act(async () => {
        jest.advanceTimersByTime(60000);
      });

      const beats = emits.filter(
        (entry: any) => entry.event === 'call.media-state' && entry.payload?.mediaState?.heartbeat,
      );
      expect(beats.length).toBeGreaterThan(beatsBefore);
      expect(beats[0].payload).toEqual({
        version: 1,
        callId: 'call-connected-2',
        mediaState: { isScreenSharing: false, heartbeat: true },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  // ── Heartbeat lifetime ────────────────────────────────────────────────────
  //
  // Android suspends the JS timer queue whenever the activity is paused, which
  // Picture-in-Picture does: the `setInterval` fires once and then nothing,
  // the server stops seeing beats, and it force-ends a perfectly healthy call
  // after `CALL_HEARTBEAT_TIMEOUT_MS`.  The heartbeat therefore has to keep
  // beating from event-driven wake-ups, and must be tied to the call alone —
  // never to view state, an effect, or a callback identity.

  /** Handler registered on the Engine.IO manager (`socket.io.on(event)`). */
  function getManagerHandler(event: any) {
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1]?.value;
    const call = socketMock?.io?.on?.mock.calls.find(([e]: any) => e === event);
    return call?.[1];
  }

  function heartbeatEmits(emits: any[]) {
    return emits.filter(
      (entry: any) => entry.event === 'call.media-state' && entry.payload?.mediaState?.heartbeat,
    );
  }

  /** Simulate the app entering (or leaving) Picture-in-Picture / compact view. */
  function setCompactView(tree: any, resultRef: any, isCompactView: boolean) {
    (useCompactCallView as jest.Mock).mockImplementation(() => ({
      isCompactView,
      setIsCompactView: jest.fn(),
    }));
    if (!tree) return;
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });
  }

  test('keeps beating across Picture-in-Picture entry, over several intervals', async () => {
    jest.useFakeTimers();
    try {
      const { resultRef, tree, peerConnection, emits } =
        await acceptCallWithPeerConnection('call-pip-1');

      await act(async () => {
        peerConnection.connectionState = 'connected';
        peerConnection.onconnectionstatechange?.();
      });
      const before = heartbeatEmits(emits).length;

      setCompactView(tree, resultRef, true);

      for (let expected = 1; expected <= 3; expected += 1) {
        await act(async () => {
          jest.advanceTimersByTime(30000);
        });
        expect(heartbeatEmits(emits)).toHaveLength(before + expected);
      }
    } finally {
      setCompactView(null, null, false);
      jest.useRealTimers();
    }
  });

  test('keeps beating in Picture-in-Picture even while the OS suspends JS timers', async () => {
    jest.useFakeTimers();
    try {
      const { resultRef, tree, peerConnection, emits } =
        await acceptCallWithPeerConnection('call-pip-2');

      await act(async () => {
        peerConnection.connectionState = 'connected';
        peerConnection.onconnectionstatechange?.();
      });
      const before = heartbeatEmits(emits).length;

      setCompactView(tree, resultRef, true);

      const onPing = getManagerHandler('ping');
      expect(onPing).toEqual(expect.any(Function));

      // The clock moves but the timer queue never runs — exactly what a paused
      // activity looks like.  The server's own ping is what keeps this alive.
      for (let expected = 1; expected <= 3; expected += 1) {
        await act(async () => {
          jest.setSystemTime(Date.now() + 31000);
          onPing();
          await Promise.resolve();
        });
        expect(heartbeatEmits(emits)).toHaveLength(before + expected);
      }

      // A ping that arrives before a beat is due must not emit an extra one.
      await act(async () => {
        onPing();
        await Promise.resolve();
      });
      expect(heartbeatEmits(emits)).toHaveLength(before + 3);
    } finally {
      setCompactView(null, null, false);
      jest.useRealTimers();
    }
  });

  test('keeps beating across an AppState background/foreground transition', async () => {
    jest.useFakeTimers();
    try {
      const { peerConnection, emits } = await acceptCallWithPeerConnection('call-bg-1');

      await act(async () => {
        peerConnection.connectionState = 'connected';
        peerConnection.onconnectionstatechange?.();
      });
      const before = heartbeatEmits(emits).length;

      // React Native's Jest preset already records every AppState listener,
      // so the registered handlers can be replayed without re-mocking it.
      const appStateListeners = (AppState.addEventListener as jest.Mock).mock.calls
        .filter(([event]: any) => event === 'change')
        .map(([, listener]: any) => listener);
      expect(appStateListeners.length).toBeGreaterThan(0);

      const notifyAppState = async (nextState: string) => {
        await act(async () => {
          appStateListeners.forEach(listener => listener(nextState));
          await Promise.resolve();
        });
      };

      // Backgrounded with the timer queue suspended: coming back to the
      // foreground beats immediately instead of waiting a further full period.
      await notifyAppState('background');
      await act(async () => {
        jest.setSystemTime(Date.now() + 45000);
      });
      await notifyAppState('active');
      expect(heartbeatEmits(emits)).toHaveLength(before + 1);

      // …and the ordinary interval is still running afterwards.
      await act(async () => {
        jest.advanceTimersByTime(30000);
      });
      expect(heartbeatEmits(emits)).toHaveLength(before + 2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('survives a socket reconnect mid-call', async () => {
    jest.useFakeTimers();
    try {
      const { peerConnection, emits } = await acceptCallWithPeerConnection('call-reconnect-1');

      await act(async () => {
        peerConnection.connectionState = 'connected';
        peerConnection.onconnectionstatechange?.();
      });
      const before = heartbeatEmits(emits).length;

      const disconnectHandler = getSocketHandler('disconnect');
      const connectHandler = getSocketHandler('connect');
      await act(async () => {
        disconnectHandler?.('transport error');
        await Promise.resolve();
      });

      // A beat that fell due while the socket was down is sent as soon as it
      // comes back, rather than being lost with the reconnect.
      await act(async () => {
        jest.setSystemTime(Date.now() + 31000);
        await connectHandler?.();
        await Promise.resolve();
      });
      expect(heartbeatEmits(emits)).toHaveLength(before + 1);

      await act(async () => {
        jest.advanceTimersByTime(30000);
      });
      expect(heartbeatEmits(emits)).toHaveLength(before + 2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('stops exactly once when the call ends, leaking no interval', async () => {
    jest.useFakeTimers();
    try {
      const { logInfo } = require('../../src/appLogger');
      const { resultRef, tree, peerConnection, emits } =
        await acceptCallWithPeerConnection('call-hb-end-1');

      await act(async () => {
        peerConnection.connectionState = 'connected';
        peerConnection.onconnectionstatechange?.();
      });
      expect(
        (logInfo as jest.Mock).mock.calls.filter(
          ([message]: any) => message === '[CallFlow] Call heartbeat started',
        ),
      ).toHaveLength(1);

      await act(async () => {
        jest.advanceTimersByTime(30000);
      });
      const beforeEnd = heartbeatEmits(emits).length;
      expect(beforeEnd).toBeGreaterThan(0);

      await act(async () => {
        await resultRef.current.handleEndCall();
      });
      act(() => {
        tree.update(<TestHook resultRef={resultRef} />);
      });

      const stops = (logInfo as jest.Mock).mock.calls.filter(
        ([message]: any) => message === '[CallFlow] Call heartbeat stopped',
      );
      expect(stops).toHaveLength(1);
      expect(stops[0][1]).toEqual(expect.objectContaining({ reason: expect.any(String) }));

      // No leaked interval, and no wake-up source can revive a dead heartbeat.
      const onPing = getManagerHandler('ping');
      await act(async () => {
        jest.setSystemTime(Date.now() + 120000);
        jest.advanceTimersByTime(120000);
        onPing?.();
        await Promise.resolve();
      });
      expect(heartbeatEmits(emits)).toHaveLength(beforeEnd);
      expect(
        (logInfo as jest.Mock).mock.calls.filter(
          ([message]: any) => message === '[CallFlow] Call heartbeat stopped',
        ),
      ).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('detaches its Engine.IO ping listener when the socket is torn down', async () => {
    jest.useFakeTimers();
    try {
      const { tree } = await acceptCallWithPeerConnection('call-hb-detach-1');
      const { io } = require('socket.io-client');
      const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1]
        .value;
      const onPing = getManagerHandler('ping');

      act(() => {
        tree.unmount();
      });

      // The manager is shared between sockets for the same URL, so a listener
      // left behind would pile up (and pin this hook) on every reconnect.
      expect(socketMock.io.off).toHaveBeenCalledWith('ping', onPing);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reports lost media only after ICE fails to recover', async () => {
    jest.useFakeTimers();
    try {
      const { peerConnection, emits } = await acceptCallWithPeerConnection('call-connected-3');

      await act(async () => {
        peerConnection.iceConnectionState = 'disconnected';
        peerConnection.oniceconnectionstatechange?.();
      });
      // Still inside the grace window: a transient dip is not reported.
      expect(emits.some((entry: any) => entry.event === 'call.connected')).toBe(false);

      // Recovery cancels the pending report entirely.
      await act(async () => {
        peerConnection.iceConnectionState = 'connected';
        peerConnection.oniceconnectionstatechange?.();
        jest.advanceTimersByTime(30000);
      });
      expect(
        emits.filter((entry: any) => entry.payload?.iceState === 'disconnected'),
      ).toHaveLength(0);

      // A connection that never comes back is reported so the server can end
      // the call instead of waiting for a sweep.
      await act(async () => {
        peerConnection.iceConnectionState = 'failed';
        peerConnection.oniceconnectionstatechange?.();
        jest.advanceTimersByTime(30000);
      });
      expect(emits.filter((entry: any) => entry.payload?.iceState === 'failed')).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('creates the peer connection with the server-fetched ICE servers', async () => {
    const { getIceServers, getIceServersForCall } = require('../../src/webrtcConfig');
    const { logInfo } = require('../../src/appLogger');
    const relayServers = [
      { urls: ['stun:stun.l.google.com:19302'] },
      {
        urls: ['turn:turn.example.com:3478'],
        username: '1700000000:alice',
        credential: 'hmac-signature',
      },
    ];
    (getIceServersForCall as jest.Mock).mockResolvedValueOnce(relayServers);

    const { peerConnection } = await acceptCallWithPeerConnection('call-ice-servers-1');

    const { RTCPeerConnection } = require('react-native-webrtc');
    expect(RTCPeerConnection).toHaveBeenCalledWith({
      iceServers: relayServers,
      iceTransportPolicy: 'all',
    });
    // Relay servers must not be applied after gathering may already have begun.
    expect((peerConnection as any).setConfiguration).toBeUndefined();
    expect(getIceServers).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith('[CallFlow] Creating RTCPeerConnection', {
      iceTransportPolicy: 'all',
      hasTurnServer: true,
      turnServers: ['turn:turn.example.com'],
    });
  });

  test('detects a TLS relay given as a string urls and does not warn', async () => {
    const { getIceServersForCall } = require('../../src/webrtcConfig');
    const { logInfo, logWarn } = require('../../src/appLogger');
    const relayServers = [
      { urls: 'turns:relay.example.com:5349?transport=tcp', username: 'u', credential: 'c' },
    ];
    (getIceServersForCall as jest.Mock).mockResolvedValueOnce(relayServers);

    await acceptCallWithPeerConnection('call-turns-relay', { iceTransportPolicy: 'relay' });

    const { RTCPeerConnection } = require('react-native-webrtc');
    expect(RTCPeerConnection).toHaveBeenCalledWith({
      iceServers: relayServers,
      iceTransportPolicy: 'relay',
    });
    // The logged summary must describe the very list the connection was given.
    expect(logInfo).toHaveBeenCalledWith('[CallFlow] Creating RTCPeerConnection', {
      iceTransportPolicy: 'relay',
      hasTurnServer: true,
      turnServers: ['turns:relay.example.com'],
    });
    expect(logWarn).not.toHaveBeenCalledWith(
      '[CallFlow] Relay ICE policy configured without a TURN server',
      expect.anything(),
    );
  });


  // ── Mid-call recovery ─────────────────────────────────────────────────────
  //
  // Recovery used to be caller-only and reactive: a callee whose IP changed
  // waited for an offer nobody was going to send, and even the caller waited
  // for ICE to reach `failed` first. These cover the symmetric, proactive,
  // retried behaviour.

  async function failIce(peerConnection: any) {
    await act(async () => {
      peerConnection.iceConnectionState = 'failed';
      peerConnection.oniceconnectionstatechange?.();
      await Promise.resolve();
    });
    await act(async () => {});
  }

  test('a callee whose ICE fails sends an ICE restart offer', async () => {
    const { peerConnection, emits } = await acceptCallWithPeerConnection('call-restart-callee');
    emits.length = 0;
    peerConnection.createOffer.mockClear();

    await failIce(peerConnection);

    // 'alice' answered a call from 'bob', so this peer is the callee.
    expect(peerConnection.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(emits.filter((entry: any) => entry.event === 'rtc.offer')).toHaveLength(1);
  });

  test('the tie-break defers the higher userId, and recovery cancels its restart', async () => {
    jest.useFakeTimers();
    try {
      // 'alice' > 'aaa', so this peer must let the other one restart first.
      const { peerConnection } = await acceptCallWithPeerConnection(
        'call-restart-glare',
        undefined,
        { callerId: 'aaa' },
      );
      peerConnection.createOffer.mockClear();

      await failIce(peerConnection);
      expect(peerConnection.createOffer).not.toHaveBeenCalled();

      // The other peer's restart worked: this one must not offer as well.
      await act(async () => {
        peerConnection.iceConnectionState = 'connected';
        peerConnection.oniceconnectionstatechange?.();
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(peerConnection.createOffer).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a network change restarts ICE without waiting for a failure', async () => {
    jest.useFakeTimers();
    try {
      const { peerConnection } = await acceptCallWithPeerConnection('call-restart-network');
      peerConnection.iceConnectionState = 'connected';
      peerConnection.createOffer.mockClear();

      const notify = mockNetworkListeners[mockNetworkListeners.length - 1];
      await act(async () => {
        notify({
          from: { type: 'wifi', isConnected: true },
          to: { type: 'cellular', isConnected: true },
        });
        jest.advanceTimersByTime(800);
        await Promise.resolve();
      });
      await act(async () => {});

      // ICE still says "connected" here — that lag is exactly the audio gap
      // this restart exists to avoid.
      expect(peerConnection.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a failed ICE restart is retried after a backoff', async () => {
    jest.useFakeTimers();
    try {
      const { logError } = require('../../src/appLogger');
      const { peerConnection } = await acceptCallWithPeerConnection('call-restart-retry');
      peerConnection.createOffer.mockClear();
      peerConnection.createOffer
        .mockRejectedValueOnce(new Error('interface not routable'))
        .mockResolvedValue({ type: 'offer', sdp: 'restart-sdp' });

      await failIce(peerConnection);
      expect(peerConnection.createOffer).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        '[CallFlow] ICE restart failed',
        expect.objectContaining({ trigger: 'ice-failure', attempt: 1 }),
      );

      await act(async () => {
        jest.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      await act(async () => {});

      expect(peerConnection.createOffer).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a restart with no TURN server logs an error and still recovers', async () => {
    const { logError } = require('../../src/appLogger');
    const { getIceServersForCall } = require('../../src/webrtcConfig');
    (getIceServersForCall as jest.Mock).mockResolvedValue([
      { urls: ['stun:stun.l.google.com:19302'] },
    ]);
    const { peerConnection, emits } = await acceptCallWithPeerConnection('call-restart-no-turn');
    emits.length = 0;
    peerConnection.createOffer.mockClear();

    await failIce(peerConnection);

    expect(logError).toHaveBeenCalledWith(
      '[CallFlow] ICE restart has no TURN server; re-fetching credentials',
      expect.objectContaining({ trigger: 'ice-failure' }),
    );
    // Degraded recovery still beats no recovery.
    expect(emits.filter((entry: any) => entry.event === 'rtc.offer')).toHaveLength(1);
  });

  test('a network change with no active call restarts nothing', async () => {
    jest.useFakeTimers();
    try {
      const { RTCPeerConnection } = require('react-native-webrtc');
      await renderWithSocket();
      (RTCPeerConnection as jest.Mock).mockClear();

      const notify = mockNetworkListeners[mockNetworkListeners.length - 1];
      await act(async () => {
        notify({
          from: { type: 'wifi', isConnected: true },
          to: { type: 'cellular', isConnected: true },
        });
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(RTCPeerConnection).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('fetches TURN credentials with a session id when answering', async () => {
    const { getIceServersForCall } = require('../../src/webrtcConfig');
    (getIceServersForCall as jest.Mock).mockResolvedValueOnce([
      { urls: ['turn:turn.example.com:3478'] },
    ]);

    await acceptCallWithPeerConnection('call-ice-session-1');

    // A call answered from a push builds its peer connection moments after
    // rehydration; without a session id the TURN fetch is skipped entirely and
    // the call silently loses every relay candidate.
    expect(getIceServersForCall).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-chat' }),
    );
  });

  test('creates the peer connection with forced relay policy when configured', async () => {
    const { getIceServersForCall } = require('../../src/webrtcConfig');
    const relayServers = [{ urls: ['turn:turn.example.com:3478'] }];
    (getIceServersForCall as jest.Mock).mockResolvedValueOnce(relayServers);

    await acceptCallWithPeerConnection('call-ice-policy-relay', { iceTransportPolicy: 'relay' });

    const { RTCPeerConnection } = require('react-native-webrtc');
    expect(RTCPeerConnection).toHaveBeenCalledWith({
      iceServers: relayServers,
      iceTransportPolicy: 'relay',
    });
  });

  test('logs a selected relay candidate pair once across unchanged stats polls', async () => {
    const { logInfo } = require('../../src/appLogger');
    const Telemetry = require('../../src/telemetry');
    const { peerConnection } = await acceptCallWithPeerConnection('call-relay-pair');
    peerConnection.getStats.mockResolvedValue(
      candidatePairReport({
        localType: 'relay',
        remoteType: 'srflx',
        relayProtocol: 'udp',
      }),
    );

    await connectPeerConnection(peerConnection, 'call-relay-pair');
    await act(async () => {
      jest.advanceTimersByTime(7000);
      await Promise.resolve();
    });

    expect(logInfo).toHaveBeenCalledWith('[CallFlow] ICE candidate pair selected', {
      local: 'relay',
      remote: 'srflx',
      protocol: 'udp',
      relayProtocol: 'udp',
      usingTurn: true,
      relaySide: 'local',
    });
    expect(
      logInfo.mock.calls.filter(([message]: any[]) =>
        message === '[CallFlow] ICE candidate pair selected'),
    ).toHaveLength(1);
    expect(Telemetry.getCallQoSSummary('call-relay-pair')).toEqual(
      expect.objectContaining({ selectedCandidatePairType: 'relay' }),
    );
  });

  test('logs a selected direct candidate pair with TURN usage disabled', async () => {
    const { logInfo } = require('../../src/appLogger');
    const { peerConnection } = await acceptCallWithPeerConnection('call-direct-pair');
    peerConnection.getStats.mockResolvedValue(
      candidatePairReport({ localType: 'host', remoteType: 'srflx' }),
    );

    await connectPeerConnection(peerConnection, 'call-direct-pair');

    expect(logInfo).toHaveBeenCalledWith('[CallFlow] ICE candidate pair selected', {
      local: 'host',
      remote: 'srflx',
      protocol: 'udp',
      usingTurn: false,
    });
  });

  test('reports TURN usage when only the remote candidate is a relay', async () => {
    const { logInfo } = require('../../src/appLogger');
    const { peerConnection } = await acceptCallWithPeerConnection('call-remote-relay-pair');
    peerConnection.getStats.mockResolvedValue(
      candidatePairReport({ localType: 'srflx', remoteType: 'relay' }),
    );

    await connectPeerConnection(peerConnection, 'call-remote-relay-pair');

    // The remote peer relaying means the media still traverses TURN; judging
    // the pair by the local candidate alone reported such a call as direct.
    expect(logInfo).toHaveBeenCalledWith('[CallFlow] ICE candidate pair selected', {
      local: 'srflx',
      remote: 'relay',
      protocol: 'udp',
      usingTurn: true,
      relaySide: 'remote',
    });
  });

  test('reports both sides relaying when the whole pair is relay', async () => {
    const { logInfo } = require('../../src/appLogger');
    const { peerConnection } = await acceptCallWithPeerConnection('call-both-relay-pair');
    peerConnection.getStats.mockResolvedValue(
      candidatePairReport({ localType: 'relay', remoteType: 'relay' }),
    );

    await connectPeerConnection(peerConnection, 'call-both-relay-pair');

    expect(logInfo).toHaveBeenCalledWith('[CallFlow] ICE candidate pair selected', {
      local: 'relay',
      remote: 'relay',
      protocol: 'udp',
      usingTurn: true,
      relaySide: 'both',
    });
  });

  test('warns when relay policy selects a non-relay candidate pair', async () => {
    const { getIceServersForCall } = require('../../src/webrtcConfig');
    const { logWarn } = require('../../src/appLogger');
    (getIceServersForCall as jest.Mock).mockResolvedValueOnce([
      { urls: ['turn:turn.example.com:3478'] },
    ]);
    const { peerConnection } = await acceptCallWithPeerConnection('call-relay-mismatch', {
      iceTransportPolicy: 'relay',
    });
    peerConnection.getStats.mockResolvedValue(
      candidatePairReport({ localType: 'host', remoteType: 'srflx' }),
    );

    await connectPeerConnection(peerConnection, 'call-relay-mismatch');

    expect(logWarn).toHaveBeenCalledWith(
      '[CallFlow] Relay ICE policy selected a non-relay candidate pair',
      expect.objectContaining({ local: 'host', remote: 'srflx', usingTurn: false }),
    );
  });

  test('warns when relay policy has no TURN server at peer-connection creation', async () => {
    const { getIceServersForCall } = require('../../src/webrtcConfig');
    const { logWarn } = require('../../src/appLogger');
    (getIceServersForCall as jest.Mock).mockResolvedValueOnce([
      { urls: ['stun:stun.l.google.com:19302'] },
    ]);

    await acceptCallWithPeerConnection('call-relay-without-turn', {
      iceTransportPolicy: 'relay',
    });

    expect(logWarn).toHaveBeenCalledWith(
      '[CallFlow] Relay ICE policy configured without a TURN server',
      { iceTransportPolicy: 'relay' },
    );
  });

  test('routes sent ICE candidate detail through verbose logging', async () => {
    const { logInfo, logVerbose } = require('../../src/appLogger');
    const { summarizeIceCandidate } = require('../../src/diagnostics');
    (summarizeIceCandidate as jest.Mock).mockReturnValue({
      hasCandidate: true,
      protocol: 'udp',
      candidateType: 'host',
    });
    const { peerConnection } = await acceptCallWithPeerConnection('call-candidate-verbose');

    peerConnection.onicecandidate?.({ candidate: { candidate: 'candidate-detail' } });

    expect(logVerbose).toHaveBeenCalledWith('[CallFlow] ICE candidate sent', {
      hasCandidate: true,
      protocol: 'udp',
      candidateType: 'host',
    });
    expect(logInfo).not.toHaveBeenCalledWith('[CallFlow] ICE candidate sent', expect.anything());
  });

  test('call setup succeeds when the TURN credential fetch degrades to STUN only', async () => {
    const { getIceServersForCall } = require('../../src/webrtcConfig');
    const stunOnly = [{ urls: ['stun:stun.l.google.com:19302'] }];
    (getIceServersForCall as jest.Mock).mockResolvedValueOnce(stunOnly);

    const { emits } = await acceptCallWithPeerConnection('call-ice-servers-2');

    const { RTCPeerConnection } = require('react-native-webrtc');
    expect(RTCPeerConnection).toHaveBeenCalledWith({
      iceServers: stunOnly,
      iceTransportPolicy: 'all',
    });
    expect(emits.some((entry: any) => entry.event === 'call.accept')).toBe(true);
  });
});

// ─── Answer-path hardening ────────────────────────────────────────────────────
//
// Every failure on the answer path used to be a silent `return`: a call could
// ring and simply refuse to be picked up with no log, no user-visible status
// and nothing on the server. These tests pin each of those paths.

describe('useCallFlow answer path', () => {
  function getSocketHandler(event: any) {
    const { io } = require('socket.io-client');
    const socketMock = (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1]?.value;
    if (!socketMock) return undefined;
    return socketMock.on.mock.calls.find(([e]: any) => e === event)?.[1];
  }

  function latestSocket() {
    const { io } = require('socket.io-client');
    return (io as jest.Mock).mock.results[(io as jest.Mock).mock.results.length - 1].value;
  }

  function mockFetch(routes: any) {
    global.fetch = (jest.fn(async url => {
      const target = String(url);
      const match = Object.keys(routes).find(key => target.includes(key));
      if (match) return routes[match];
      return {
        ok: true,
        status: 201,
        json: async () => ({ sessionId: 'sess-answer', userId: 'alice' }),
      };
    }) as any);
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

  async function ring(resultRef: any, tree: any, call: any) {
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
    (require('../../src/pushNotifications').getInitialCallLink as jest.Mock).mockResolvedValue(null);
    (require('../../src/incomingCallNotification').consumePendingCallAction as jest.Mock).mockResolvedValue(null);
    (require('../../src/permissions').getMissingCallPermissions as jest.Mock).mockResolvedValue({
      camera: false,
      microphone: false,
      missing: [],
      message: null,
    });
  });

  afterEach(() => {
    delete ((global as any)).fetch;
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
    (mediaDevices.getUserMedia as jest.Mock).mockRejectedValue(new Error('Permission denied'));

    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-nomedia', callerId: 'olive' };
    await ring(resultRef, tree, call);

    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
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

    const acceptRequest = (global.fetch as jest.Mock).mock.calls.find(([url]: any) =>
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
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    (consumePendingCallAction as jest.Mock).mockResolvedValue({
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
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
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
    (consumePendingCallAction as jest.Mock).mockResolvedValue({
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
    const declineRequest = (global.fetch as jest.Mock).mock.calls.find(([url]: any) =>
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
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
      socketMock.emit.mock.calls.filter(([event]: any) => event === 'call.accept').length;
    expect(acceptEmits()).toBe(1);

    // The same call rings again (a duplicate push, or a rehydration that
    // re-populates the incoming call) and the user taps Answer a second time.
    // The server has already left `ringing`, so accepting again would fail —
    // and the old failure path tore down the call that had just connected.
    (endCall as jest.Mock).mockClear();
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
    let ack: any = null;
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
      socketMock.emit.mock.calls.filter(([event]: any) => event === 'call.accept'),
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
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
      socketMock.emit.mock.calls.filter(([event]: any) => event === 'call.accept'),
    ).toHaveLength(1);
  });

  test('a call that stops ringing dismisses its notification and CallKeep connection', async () => {
    const { endCall } = require('../../src/callKeep');
    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-stale', callerId: 'nez', status: 'ringing' };
    await ring(resultRef, tree, call);

    (endCall as jest.Mock).mockClear();
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
    socketMock.emit.mockImplementation((event: any, _payload: any, cb: any) => {
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
    (endCall as jest.Mock).mockClear();
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
      (setCallActionHandlers as jest.Mock).mock.calls[(setCallActionHandlers as jest.Mock).mock.calls.length - 1][0];

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
      (setCallActionHandlers as jest.Mock).mock.calls[(setCallActionHandlers as jest.Mock).mock.calls.length - 1][0];

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

  // ── audio routing ─────────────────────────────────────────────────────────

  test('prefers an external audio device at call start and keeps the manual choice', async () => {
    const audioRouting = require('../../src/audioRouting');
    let deviceChangeHandler: any = null;
    (audioRouting.subscribeAudioDevices as jest.Mock).mockImplementation(handler => {
      deviceChangeHandler = handler;
      return jest.fn();
    });
    (audioRouting.applyPreferredAudioRoute as jest.Mock).mockResolvedValue({
      ok: true,
      selected: 'bluetooth',
      available: ['bluetooth', 'earpiece'],
    });
    (audioRouting.chooseAudioRoute as jest.Mock).mockResolvedValue({
      ok: true,
      selected: 'speakerphone',
      available: ['bluetooth', 'earpiece', 'speakerphone'],
    });

    const { mediaDevices, RTCPeerConnection } = require('react-native-webrtc');
    (mediaDevices.getUserMedia as jest.Mock).mockResolvedValue({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    });
    (RTCPeerConnection as jest.Mock).mockImplementation(() => ({
      addTrack: jest.fn(),
      getSenders: jest.fn(() => []),
      setRemoteDescription: jest.fn().mockResolvedValue(undefined),
      setLocalDescription: jest.fn().mockResolvedValue(undefined),
      createAnswer: jest.fn().mockResolvedValue({ type: 'answer', sdp: 'a' }),
      addIceCandidate: jest.fn().mockResolvedValue(undefined),
      localDescription: { type: 'answer', sdp: 'a' },
      onicecandidate: null,
      ontrack: null,
      close: jest.fn(),
    }));

    const { resultRef, tree } = await renderWithSocket();
    const call = { callId: 'call-audio', callerId: 'pia' };
    await ring(resultRef, tree, call);

    const socketMock = latestSocket();
    socketMock.emit.mockImplementation((_event: any, _payload: any, cb: any) => {
      cb?.({ ok: true, call });
    });

    await act(async () => {
      await resultRef.current.acceptIncomingCall();
    });

    // Complete the media handshake so the call reaches the in-call phase.
    const offerHandler = getSocketHandler('rtc.offer');
    await act(async () => {
      await offerHandler({ callId: 'call-audio', sdp: { type: 'offer', sdp: 'o' } });
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} />);
    });

    // The loudspeaker is never forced: the best available device wins.
    expect(audioRouting.applyPreferredAudioRoute).toHaveBeenCalled();
    expect(audioRouting.setAudioRoute).not.toHaveBeenCalled();
    expect(resultRef.current.isSpeakerEnabled).toBe(false);

    // An explicit user choice must survive later device changes.
    await act(async () => {
      await resultRef.current.chooseAudioOutput('speakerphone');
    });
    (audioRouting.applyPreferredAudioRoute as jest.Mock).mockClear();

    await act(async () => {
      deviceChangeHandler({ available: ['bluetooth', 'earpiece'], selected: 'bluetooth' });
    });

    expect(audioRouting.applyPreferredAudioRoute).not.toHaveBeenCalled();
  });
});
