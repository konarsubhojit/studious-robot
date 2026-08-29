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

jest.mock('../src/observability', () => ({ getDegradations: jest.fn(() => []) }));

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

// The primer's own decision logic is covered by its hook's tests; here the
// shell only has to route to it.
jest.mock('../src/hooks/usePermissionsPrimer', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    isPrimerVisible: false,
    isPrimerResolved: true,
    acceptPrimer: jest.fn(async () => {}),
    skipPrimer: jest.fn(async () => {}),
  })),
}));

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
jest.mock('../src/components/PermissionsPrimerScreen', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="screen-permissions-primer">primer</Text> };
});

import React from 'react';
import { AccessibilityInfo, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act } from 'react-test-renderer';
import AppShell from '../src/AppShell';
import { CALL_STATES } from '../src/call/callStateMachine';
import { palettes } from '../src/theme';
import { CallProvider, useCall } from '../src/call/CallProvider';
import { ChatProvider } from '../src/chat/ChatProvider';
import useCallFlow from '../src/hooks/useCallFlow';
import usePermissionsPrimer from '../src/hooks/usePermissionsPrimer';
import { getDegradations } from '../src/observability';

const useCallFlowMock = ((useCallFlow) as jest.Mock);
const usePermissionsPrimerMock = ((usePermissionsPrimer) as jest.Mock);

/** @param isPrimerVisible */
function mockPrimer(isPrimerVisible: boolean) {
  usePermissionsPrimerMock.mockReturnValue({
    isPrimerVisible,
    isPrimerResolved: true,
    acceptPrimer: jest.fn(async () => {}),
    skipPrimer: jest.fn(async () => {}),
  });
}
const getDegradationsMock = ((getDegradations) as jest.Mock);

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

const callRef: { current: any; } = { current: null };

function CallProbe() {
  callRef.current = useCall();
  return null;
}

async function renderShell() {
  let tree: any;
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
function findByTestID(tree: any, testID: string) {
  return tree.root.findAll((node: any) => typeof node.type === 'string' && node.props?.testID === testID);
}

describe('AppShell screen routing', () => {
  beforeEach(() => {
    mockPrimer(false);
  });

  afterEach(() => {
    jest.clearAllMocks();
    callRef.current = null;
  });

  test('renders nothing while the identity is loading', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow({ isLoadingIdentity: true, isRegistered: false }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-registration')).toHaveLength(0);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });

  test('renders the registration screen for an unregistered user', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow({ isRegistered: false }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-registration')).toHaveLength(1);
  });

  test('renders the tab shell while idle', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow());
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(1);
    expect(findByTestID(tree, 'call-bubble')).toHaveLength(0);
  });

  test('renders the permissions primer on first run, ahead of the tab shell', async () => {
    mockPrimer(true);
    useCallFlowMock.mockReturnValue(makeCallFlow());

    const tree = await renderShell();

    expect(findByTestID(tree, 'screen-permissions-primer')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });

  test('never covers the sign-in screen with the primer', async () => {
    mockPrimer(true);
    useCallFlowMock.mockReturnValue(makeCallFlow({ isRegistered: false }));

    const tree = await renderShell();

    expect(findByTestID(tree, 'screen-registration')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-permissions-primer')).toHaveLength(0);
  });

  test('an incoming call outranks the primer', async () => {
    mockPrimer(true);
    useCallFlowMock.mockReturnValue(
      makeCallFlow({
        callPhase: CALL_STATES.INCOMING_RINGING,
        incomingCall: { callerId: 'bob', callId: 'c1' },
      }),
    );

    const tree = await renderShell();

    // A ringing phone is not the moment for an explanation.
    expect(findByTestID(tree, 'screen-incoming')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-permissions-primer')).toHaveLength(0);
  });

  test('renders the outgoing screen while an outgoing call rings', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.OUTGOING_RINGING }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-outgoing')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });

  test('renders the incoming screen while an incoming call rings', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.INCOMING_RINGING }));
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-incoming')).toHaveLength(1);
  });

  test('renders the call screen while connected', async () => {
    useCallFlowMock.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }),
    );
    const tree = await renderShell();
    expect(findByTestID(tree, 'screen-call')).toHaveLength(1);
    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(0);
  });

  test('minimizing a connected call shows the tab shell with the bubble and banner', async () => {
    useCallFlowMock.mockReturnValue(
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
    useCallFlowMock.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.INCOMING_RINGING }));
    const tree = await renderShell();

    act(() => {
      callRef.current.minimizeCall();
    });

    expect(findByTestID(tree, 'screen-incoming')).toHaveLength(1);
    expect(findByTestID(tree, 'call-bubble')).toHaveLength(0);
  });

  test('OS picture-in-picture keeps the call full screen even when minimized', async () => {
    useCallFlowMock.mockReturnValue(
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

describe('AppShell system chrome', () => {
  beforeEach(() => {
    mockPrimer(false);
    getDegradationsMock.mockReturnValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
    callRef.current = null;
  });

  /** The single `StatusBar` element the shell renders. */
  function statusBar(tree: any) {
    return tree.root.findAll((node: any) => node.props?.barStyle !== undefined)[0].props;
  }

  test('tints the status bar from the active palette', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow());
    const tree = await renderShell();

    // Read from the palette, not from the scheme name, so a high-contrast or
    // true-black background reaches the system chrome too.
    expect(statusBar(tree).backgroundColor).toBe(palettes.dark.background);
    expect(statusBar(tree).barStyle).toBe('light-content');
  });

  test('follows the video stage while a call is full screen', async () => {
    // The stage is fixed-dark in both schemes, so a light-scheme user would
    // otherwise get a white bar with dark icons on top of black video.
    useCallFlowMock.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }),
    );
    const tree = await renderShell();

    expect(statusBar(tree).backgroundColor).toBe(palettes.dark.stage);
    expect(statusBar(tree).barStyle).toBe('light-content');
  });

  test('stays opaque, so the bar colour never eats the safe-area padding', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow());
    const tree = await renderShell();
    expect(statusBar(tree).translucent).toBe(false);
  });
});

describe('CallProvider', () => {
  afterEach(() => jest.clearAllMocks());

  test('exposes the participant label and ends a call from the minimized bubble', async () => {
    const handleEndCall = jest.fn();
    useCallFlowMock.mockReturnValue(
      makeCallFlow({
        callPhase: CALL_STATES.IN_CALL,
        isInCall: true,
        handleEndCall,
        activeCall: { callId: 'call-1', callerId: 'user-alice', calleeId: 'user-bob' },
      }),
    );
    await renderShell();

    // The local user is `user-alice` (the caller here), so the label has to
    // name the *other* end of the call.
    expect(callRef.current.participantLabel).toBe('Call with user-bob');
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

  test('labels the call with the remote party when this device is the callee', async () => {
    useCallFlowMock.mockReturnValue(
      makeCallFlow({
        callPhase: CALL_STATES.IN_CALL,
        isInCall: true,
        userId: 'user-bob',
        // Swapping the tiles must not change who the remote party is.
        isLocalPrimary: true,
        activeCall: { callId: 'call-1', callerId: 'user-alice', calleeId: 'user-bob' },
      }),
    );
    await renderShell();

    expect(callRef.current.participantLabel).toBe('Call with user-alice');
  });

  test('navigating away minimizes a connected call but leaves a ringing one alone', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.OUTGOING_RINGING }));
    await renderShell();

    act(() => {
      callRef.current.minimizeCallOnNavigate();
    });
    expect(callRef.current.isCallMinimized).toBe(false);

    useCallFlowMock.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }),
    );
    await renderShell();

    act(() => {
      callRef.current.minimizeCallOnNavigate();
    });
    expect(callRef.current.isCallMinimized).toBe(true);
  });
});

describe('AppShell accessibility and error states', () => {
  let announce: jest.SpyInstance;

  beforeEach(() => {
    announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation();
    announce.mockClear();
    getDegradationsMock.mockReturnValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
    callRef.current = null;
  });

  test('announces an incoming call to screen readers', async () => {
    useCallFlowMock.mockReturnValue(
      makeCallFlow({
        callPhase: CALL_STATES.INCOMING_RINGING,
        incomingCall: { callId: 'call-1', callerId: 'user-alice' },
      }),
    );
    await renderShell();

    expect(announce).toHaveBeenCalledWith('Incoming call from user-alice');
  });

  test('announces a connected call', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }));
    await renderShell();

    expect(announce).toHaveBeenCalledWith('Call connected');
  });

  test('says nothing while idle', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow());
    await renderShell();

    expect(announce).not.toHaveBeenCalled();
  });

  test('announces the start and the end of a mid-call recovery', async () => {
    useCallFlowMock.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true }),
    );
    const tree = await renderShell();

    expect(announce).not.toHaveBeenCalledWith('Connection lost, reconnecting');

    useCallFlowMock.mockReturnValue(
      makeCallFlow({ callPhase: CALL_STATES.IN_CALL, isInCall: true, isReconnecting: true }),
    );
    await act(async () => {
      tree.update(
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

    expect(announce).toHaveBeenCalledWith('Connection lost, reconnecting');
  });

  test('never announces a recovery outside a call, where "Reconnected" would be a lie', async () => {
    useCallFlowMock.mockReturnValue(makeCallFlow({ isReconnecting: true }));
    await renderShell();

    expect(announce).not.toHaveBeenCalledWith('Connection lost, reconnecting');
    expect(announce).not.toHaveBeenCalledWith('Reconnected');
  });

  test('states the startup degradation as a persistent condition, not a blocking failure', async () => {
    getDegradationsMock.mockReturnValue([
      { source: 'backgroundPush', message: 'Background push handler unavailable' },
    ]);
    useCallFlowMock.mockReturnValue(makeCallFlow());
    const tree = await renderShell();

    const texts = tree.root
      .findAll((node: any) => typeof node.type === 'string')
      .flatMap((node: any) =>
        (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]).filter(
          (child: unknown) => typeof child === 'string',
        ),
      );
    expect(texts).toContain(
      'Calling may not work reliably: Background push handler unavailable',
    );
  });

  test('offers a recovery action for startup degradations', async () => {
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockImplementation(() => Promise.resolve());
    getDegradationsMock.mockReturnValue([
      { source: 'backgroundPush', message: 'Background push handler unavailable' },
    ]);
    useCallFlowMock.mockReturnValue(makeCallFlow());
    const tree = await renderShell();

    const [banner] = findByTestID(tree, 'startup-degraded-banner');
    expect(banner.props.accessibilityRole).toBe('alert');

    const action = tree.root.find(
      (node: any) =>
        node.props?.testID === 'startup-degraded-banner-action' &&
        typeof node.props.onPress === 'function',
    );
    expect(action.props.accessibilityRole).toBe('button');
    await act(async () => {
      action.props.onPress();
    });
    expect(openSettings).toHaveBeenCalled();
  });
});
