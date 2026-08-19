jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logVerbose: jest.fn(),
  logWarn: jest.fn(),
  getLogsForExport: jest.fn(async () => ''),
}));

jest.mock('../src/startupHealth', () => ({ getStartupIssues: () => [] }));

jest.mock('../src/hooks/useCallFlow', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../src/hooks/useChatSync', () => ({
  __esModule: true,
  default: () => ({
    peerPresence: null,
    isRefreshingConversations: false,
    handleRefreshConversations: jest.fn(),
    handleLoadOlderMessages: jest.fn(),
  }),
}));

jest.mock('../src/hooks/useChatDeepLink', () => ({ __esModule: true, default: () => {} }));

// The draggable self-view is gesture/worklet driven and covered by its own
// tests; the shell only forwards its handles.
jest.mock('../src/hooks/usePictureInPicturePip', () => ({
  __esModule: true,
  default: () => ({
    stageSize: { width: 0, height: 0 },
    handleCallStageLayout: jest.fn(),
    pipGesture: null,
    animatedPipStyle: {},
  }),
}));

// The screens themselves are covered by their own tests; the shell only has to
// pick the right one for the current call state.
jest.mock('../src/components/TabShell', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="screen-tab-shell">tabs</Text> };
});
jest.mock('../src/components/CallScreen', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="screen-call">call</Text> };
});
jest.mock('../src/components/RegistrationScreen', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="screen-registration">register</Text> };
});
jest.mock('../src/components/OutgoingCallScreen', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="screen-outgoing">outgoing</Text> };
});
jest.mock('../src/components/IncomingCallScreen', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="screen-incoming">incoming</Text> };
});
jest.mock('../src/components/FloatingCallBubble', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="call-bubble">bubble</Text> };
});
jest.mock('../src/components/InCallBanner', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="call-banner">banner</Text> };
});

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act } from 'react-test-renderer';
import AppShell from '../src/AppShell';
import { CALL_STATES } from '../src/call/callStateMachine';
import { CallProvider, useCall } from '../src/call/CallProvider';
import { ChatProvider } from '../src/chat/ChatProvider';
import useCallFlow from '../src/hooks/useCallFlow';

function makeCallFlow(overrides = {}) {
  return {
    isLoadingIdentity: false,
    isRegistered: true,
    isAuthenticating: false,
    callPhase: CALL_STATES.IDLE,
    isInCall: false,
    isCompactView: false,
    activeCall: null,
    incomingCall: null,
    status: { message: '', severity: 'info' },
    conversations: [],
    messagesByPeer: {},
    typingByPeer: {},
    unreadTotal: 0,
    userId: 'user-alice',
    localStream: null,
    remoteStream: null,
    isLocalPrimary: false,
    isFrontCamera: true,
    updateStatus: jest.fn(),
    handleSwapStreams: jest.fn(),
    handleEndCall: jest.fn(),
    handleVideoToggle: jest.fn(),
    setCalleeId: jest.fn(),
    placeCall: jest.fn(),
    ...overrides,
  };
}

const callRef = { current: null };

function CallProbe() {
  callRef.current = useCall();
  return null;
}

async function renderShell() {
  let tree;
  // Async act so the persisted-settings load resolves before assertions.
  await act(async () => {
    tree = renderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 320, height: 640 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        }}>
        <CallProvider>
          <ChatProvider>
            <CallProbe />
            <AppShell />
          </ChatProvider>
        </CallProvider>
      </SafeAreaProvider>,
    );
  });
  return tree;
}

// Only host elements are counted, so a testID that appears on both a mocked
// component and the host element it renders is not double counted.
function findByTestID(tree, testID) {
  return tree.root.findAll(node => typeof node.type === 'string' && node.props?.testID === testID);
}

describe('AppShell screen routing', () => {
  afterEach(() => {
    jest.clearAllMocks();
    callRef.current = null;
  });

  test('renders nothing while the identity is loading', async () => {
    useCallFlow.mockReturnValue(makeCallFlow({ isLoadingIdentity: true, isRegistered: false }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-registration')).toHaveLength(0);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });

  test('renders the registration screen for an unregistered user', async () => {
    useCallFlow.mockReturnValue(makeCallFlow({ isRegistered: false }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-registration')).toHaveLength(1);
  });

  test('renders the tab shell while idle', async () => {
    useCallFlow.mockReturnValue(makeCallFlow());
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(1);
    expect(findByTestID(tree, 'call-bubble')).toHaveLength(0);
  });

  test('renders the outgoing screen while an outgoing call rings', async () => {
    useCallFlow.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.OUTGOING_RINGING }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-outgoing')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });

  test('renders the incoming screen while an incoming call rings', async () => {
    useCallFlow.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.INCOMING_RINGING }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-incoming')).toHaveLength(1);
  });

  test('renders the call screen while connected', async () => {
    useCallFlow.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }),
    );
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-call')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });

  test('minimizing a connected call shows the tab shell with the bubble and banner', async () => {
    useCallFlow.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }),
    );
    const tree = await renderShell();

    act(() => {
      callRef.current.minimizeCall();
    });

    expect(findByTestID(tree, 'screen-call')).toHaveLength(0);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(1);
    expect(findByTestID(tree, 'call-bubble')).toHaveLength(1);
    expect(findByTestID(tree, 'call-banner')).toHaveLength(1);
  });

  test('a ringing call is never minimizable', async () => {
    useCallFlow.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.INCOMING_RINGING }));
    const tree = await renderShell();

    act(() => {
      callRef.current.minimizeCall();
    });

    expect(findByTestID(tree, 'screen-incoming')).toHaveLength(1);
    expect(findByTestID(tree, 'call-bubble')).toHaveLength(0);
  });

  test('OS picture-in-picture keeps the call full screen even when minimized', async () => {
    useCallFlow.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true, isCompactView: true }),
    );
    const tree = await renderShell();

    act(() => {
      callRef.current.minimizeCall();
    });

    expect(findByTestID(tree, 'screen-call')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });
});

describe('CallProvider', () => {
  afterEach(() => jest.clearAllMocks());

  test('exposes the participant label and ends a call from the minimized bubble', async () => {
    const handleEndCall = jest.fn();
    useCallFlow.mockReturnValue(
      makeCallFlow({
        callPhase: CALL_STATES.IN_CALL,
        isInCall: true,
        handleEndCall,
        activeCall: { callId: 'call-1', callerId: 'user-alice', calleeId: 'user-bob' },
      }),
    );
    await renderShell();

    expect(callRef.current.participantLabel).toBe('Call with user-alice');
    expect(callRef.current.isCallConnected).toBe(true);

    act(() => {
      callRef.current.minimizeCall();
    });
    expect(callRef.current.isCallMinimized).toBe(true);

    act(() => {
      callRef.current.endCall();
    });
    expect(handleEndCall).toHaveBeenCalledTimes(1);
    expect(callRef.current.isCallMinimized).toBe(false);
  });

  test('navigating away minimizes a connected call but leaves a ringing one alone', async () => {
    useCallFlow.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.OUTGOING_RINGING }));
    await renderShell();

    act(() => {
      callRef.current.minimizeCallOnNavigate();
    });
    expect(callRef.current.isCallMinimized).toBe(false);

    useCallFlow.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }),
    );
    await renderShell();

    act(() => {
      callRef.current.minimizeCallOnNavigate();
    });
    expect(callRef.current.isCallMinimized).toBe(true);
  });
});
