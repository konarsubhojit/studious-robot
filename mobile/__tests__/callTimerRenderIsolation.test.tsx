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

jest.mock('../src/hooks/useCallFlow', () => ({ __esModule: true, default: jest.fn() }));

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

jest.mock('../src/hooks/usePictureInPicturePip', () => ({
  __esModule: true,
  default: () => ({
    stageSize: { width: 0, height: 0 },
    handleCallStageLayout: jest.fn(),
    pipGesture: null,
    animatedPipStyle: {},
  }),
}));

// Stands in for the whole tab shell — the chat list, an open conversation and
// its message bubbles, the calls tab. Counting its renders is the cheapest
// proxy for "did the call timer disturb the rest of the app".
const tabShellRenderCount = { current: 0 };
jest.mock('../src/components/TabShell', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: () => {
      tabShellRenderCount.current += 1;
      return <Text testID="screen-tab-shell">tabs</Text>;
    },
  };
});

jest.mock('../src/components/CallScreen', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="screen-call">call</Text> };
});
jest.mock('../src/components/FloatingCallBubble', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: () => <Text testID="call-bubble">bubble</Text> };
});

import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act } from 'react-test-renderer';
import AppShell from '../src/AppShell';
import { CALL_STATES } from '../src/call/callStateMachine';
import { CallProvider, useCall } from '../src/call/CallProvider';
import { ChatProvider } from '../src/chat/ChatProvider';
import useCallFlow from '../src/hooks/useCallFlow';

const useCallFlowMock = ((useCallFlow) as jest.Mock);

const CALL_CONNECTED_AT_MS = 1_700_000_000_000;

/**
 * A call flow whose identity is stable across renders — which is what the real
 * hook now provides, because the elapsed second is no longer part of its
 * result.
 */
const stableCallFlow = {
  isLoadingIdentity: false,
  isRegistered: true,
  isAuthenticating: false,
  callPhase: CALL_STATES.IN_CALL,
  isInCall: true,
  isCompactView: false,
  activeCall: { callId: 'call-1', callerId: 'user-alice', calleeId: 'user-bob' },
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
  isMuted: false,
  isScreenSharing: false,
  callConnectedAtMs: CALL_CONNECTED_AT_MS,
  updateStatus: jest.fn(),
  handleSwapStreams: jest.fn(),
  handleEndCall: jest.fn(),
  handleVideoToggle: jest.fn(),
  handleMuteToggle: jest.fn(),
  handleScreenShareToggle: jest.fn(),
  setCalleeId: jest.fn(),
  placeCall: jest.fn(),
};

const callRef: { current: any; } = { current: null };

function CallProbe() {
  callRef.current = useCall();
  return null;
}

function findByTestID(tree: any, testID: string) {
  return tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
  );
}

/** The duration currently shown in the minimized-call banner. */
function bannerDuration(tree: any): string {
  const banner = findByTestID(tree, 'in-call-banner')[0];
  // Matched by shape rather than by position: the banner also carries the
  // avatar's initials and the mute/end glyphs, so "the last Text" is not the
  // timer.
  const durations = banner
    .findAll((node: any) => node.type === 'Text')
    .map((node: any) => node.children.join(''))
    .filter((text: string) => /^\d{2}:\d{2}$/.test(text));
  return durations[durations.length - 1];
}

describe('the call timer does not re-render the rest of the app', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(CALL_CONNECTED_AT_MS);
    tabShellRenderCount.current = 0;
    useCallFlowMock.mockReturnValue(stableCallFlow);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    callRef.current = null;
  });

  test('advancing the elapsed timer updates the banner without re-rendering the tab shell', async () => {
    let tree: any;
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

    // Minimize the connected call so the tab shell and the duration banner are
    // on screen at the same time.
    await act(async () => {
      callRef.current.minimizeCall();
    });

    expect(findByTestID(tree, 'screen-tab-shell')).toHaveLength(1);
    expect(bannerDuration(tree)).toBe('00:00');

    const rendersBeforeTicking = tabShellRenderCount.current;

    // Five seconds of call time. `advanceTimersByTime` moves the mocked clock
    // too, so the hook reads a real elapsed duration.
    for (let second = 0; second < 5; second += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }

    // The banner tracked the call...
    expect(bannerDuration(tree)).toBe('00:05');
    // ...and nothing else in the app was disturbed by it. Before the elapsed
    // second was moved out of `useCallFlow`, this counted five extra renders of
    // every mounted screen.
    expect(tabShellRenderCount.current).toBe(rendersBeforeTicking);

    // Sensitivity check: the counter is wired up, so the assertion above is
    // "the timer changed nothing", not "nothing is being counted". A genuine
    // call-state change must still reach the shell.
    await act(async () => {
      callRef.current.dismissBubble();
    });
    expect(tabShellRenderCount.current).toBeGreaterThan(rendersBeforeTicking);
  });
});
