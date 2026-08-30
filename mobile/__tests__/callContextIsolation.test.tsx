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

// Stable handlers: the real hook memoises them, and a mock that minted a fresh
// function per render would be measuring the mock rather than the provider.
const mockPipView = {
  stageSize: { width: 0, height: 0 },
  handleCallStageLayout: jest.fn(),
  handleTopChromeLayout: jest.fn(),
  handleBottomChromeLayout: jest.fn(),
  pipGesture: null,
  animatedPipStyle: {},
};
jest.mock('../src/hooks/usePictureInPicturePip', () => ({
  __esModule: true,
  default: () => mockPipView,
}));

// Stands in for the whole tab shell — the chat list, an open conversation, the
// calls tab. Counting its renders is the cheapest proxy for "did an unrelated
// call-state change disturb the rest of the app".
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

import React, { useMemo, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act } from 'react-test-renderer';
import AppShell from '../src/AppShell';
import { CALL_STATES } from '../src/call/callStateMachine';
import { CallProvider, useCall, useCallSelector } from '../src/call/CallProvider';
import { ChatProvider, useChat } from '../src/chat/ChatProvider';
import useCallFlow from '../src/hooks/useCallFlow';
import type { CallContextValue } from '../src/call/CallProvider';

const useCallFlowMock = ((useCallFlow) as jest.Mock);

const CALL_CONNECTED_AT_MS = 1_700_000_000_000;

/** A connected call whose action identities never change between renders. */
const baseCallFlow = {
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
  missedCallCount: 0,
  callHistory: [],
  connectionQuality: 'good',
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

const renderCounts = { whole: 0, slice: 0, chat: 0 };
const callRef: { current: CallContextValue | null; } = { current: null };

/** Reads the whole snapshot — the pre-split behaviour, kept as the control. */
function WholeSnapshotProbe() {
  callRef.current = useCall();
  renderCounts.whole += 1;
  return null;
}

const selectMissedCallCount = (state: CallContextValue) => state.callFlow.missedCallCount;

/** Reads one field of the snapshot. */
function SliceProbe() {
  useCallSelector(selectMissedCallCount);
  renderCounts.slice += 1;
  return null;
}

/** Stands in for a chat surface: reads the chat context, never the call. */
function ChatProbe() {
  useChat();
  renderCounts.chat += 1;
  return null;
}

let pushCallFlow: (next: Record<string, unknown>) => void = () => {};

/**
 * Re-renders `CallProvider` with whatever `useCallFlow` currently returns,
 * without recreating the children element — exactly how the real hook publishes
 * new state, and the only way the assertions below can be about the provider
 * rather than about a parent re-rendering the tree.
 */
function Harness() {
  const [, setRevision] = useState(0);
  pushCallFlow = next => {
    useCallFlowMock.mockReturnValue({ ...baseCallFlow, ...next });
    setRevision(revision => revision + 1);
  };
  const children = useMemo(
    () => (
      <ChatProvider>
        <WholeSnapshotProbe />
        <SliceProbe />
        <ChatProbe />
        <AppShell />
      </ChatProvider>
    ),
    [],
  );
  return <CallProvider>{children}</CallProvider>;
}

describe('call context consumers only wake for the slice they read', () => {
  beforeEach(() => {
    renderCounts.whole = 0;
    renderCounts.slice = 0;
    renderCounts.chat = 0;
    tabShellRenderCount.current = 0;
    useCallFlowMock.mockReturnValue(baseCallFlow);
  });

  afterEach(() => {
    jest.clearAllMocks();
    pushCallFlow = () => {};
    callRef.current = null;
  });

  /**
   * Mount the app with the call minimized, so the tab shell and the call
   * chrome are on screen together — the arrangement in which an unrelated
   * call-state change is most obviously somebody else's business.
   *
   * @returns nothing; the probes above record what happened
   */
  async function renderMinimizedCall() {
    await act(async () => {
      renderer.create(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 320, height: 640 },
            insets: { top: 0, left: 0, right: 0, bottom: 0 },
          }}>
          <Harness />
        </SafeAreaProvider>,
      );
    });
    await act(async () => {
      callRef.current?.minimizeCall();
    });
    // The counters are wired to something that is actually mounted.
    expect(tabShellRenderCount.current).toBeGreaterThan(0);
  }

  test('a connection-quality sample reaches neither the tab shell nor the chat context', async () => {
    await renderMinimizedCall();

    const before = { ...renderCounts, tabShell: tabShellRenderCount.current };

    // The kind of update the call flow produces continuously while a call is
    // up: a stats sample nothing outside the call screen displays.
    await act(async () => {
      pushCallFlow({ connectionQuality: 'poor' });
    });

    expect(renderCounts.slice).toBe(before.slice);
    expect(renderCounts.chat).toBe(before.chat);
    expect(tabShellRenderCount.current).toBe(before.tabShell);
    // Sensitivity check: the snapshot really did change, so the assertions
    // above are "nobody read this", not "nothing happened".
    expect(renderCounts.whole).toBeGreaterThan(before.whole);
  });

  test('a change to the selected slice still wakes its consumer', async () => {
    await renderMinimizedCall();

    const slicesBefore = renderCounts.slice;

    await act(async () => {
      pushCallFlow({ missedCallCount: 3 });
    });

    expect(renderCounts.slice).toBe(slicesBefore + 1);
  });
});
