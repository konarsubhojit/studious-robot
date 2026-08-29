import React from 'react';
import renderer, { act } from 'react-test-renderer';
import CallsScreen from '../../src/components/CallsScreen';
import { describeOffline, OFFLINE_CONSEQUENCE } from '../../src/connectivityUx';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../src/accessibilityAnnouncer', () => ({
  announceForAccessibility: jest.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const { announceForAccessibility } = require('../../src/accessibilityAnnouncer');

/** @param overrides */
const call = (overrides: any = {}): any => ({
  callId: 'call-1',
  callerId: 'user-alice',
  calleeId: 'user-bob',
  direction: 'outgoing',
  status: 'ended',
  endReason: 'ended',
  createdAt: new Date().toISOString(),
  durationSeconds: 60,
  isRead: true,
  ...overrides,
});

const baseProps: any = {
  callHistory: [],
  missedCallCount: 0,
  onMarkMissedRead: jest.fn(),
  onOpenProfile: jest.fn(),
  onAudioCall: jest.fn(),
  onVideoCall: jest.fn(),
};

/** @param props */
function render(props: any = {}) {
  let tree: any;
  act(() => {
    tree = renderer.create(<CallsScreen {...baseProps} {...props} />);
  });
  return tree;
}

/** All nodes carrying a testID, including composite and host fibers. */
const byTestID = (tree: any, testID: string) =>
  tree.root.findAll((n: any) => n.props?.testID === testID);

/** The single pressable fiber for a testID. */
const pressable = (tree: any, testID: string) =>
  byTestID(tree, testID).find((n: any) => typeof n.props?.onPress === 'function');

/**
 * How many rows the log rendered.
 *
 * A row is a `ListItem` composite, a `Pressable` and a host `View`, all
 * carrying the same testID; counting host nodes counts each row exactly once.
 */
const rowCount = (tree: any, testID: string) =>
  byTestID(tree, testID).filter((n: any) => typeof n.type === 'string').length;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CallsScreen – missed calls', () => {
  afterEach(() => jest.clearAllMocks());

  test('acknowledges missed calls on arrival so the tab badge clears', () => {
    const onMarkMissedRead = jest.fn();
    render({ missedCallCount: 3, onMarkMissedRead });
    expect(onMarkMissedRead).toHaveBeenCalledTimes(1);
  });

  test('does not acknowledge anything when nothing was missed', () => {
    const onMarkMissedRead = jest.fn();
    render({ missedCallCount: 0, onMarkMissedRead });
    expect(onMarkMissedRead).not.toHaveBeenCalled();
  });
});

describe('CallsScreen – call log', () => {
  afterEach(() => jest.clearAllMocks());

  test('shows an empty state, not an empty list, when there is no history', () => {
    const tree = render({ callHistory: [] });
    expect(byTestID(tree, 'calls-empty').length).toBeGreaterThanOrEqual(1);
    expect(byTestID(tree, 'call-history-section')).toHaveLength(0);
  });

  test('renders the whole history, not just the five most recent calls', () => {
    const history = Array.from({ length: 7 }, (_unused, i) =>
      call({ callId: `call-${i}`, durationSeconds: 60 + i }),
    );
    const tree = render({ callHistory: history });

    expect(rowCount(tree, 'call-history-row')).toBe(7);
  });

  test('rows are grouped under day headings', () => {
    const older = new Date();
    older.setDate(older.getDate() - 3);
    const tree = render({
      callHistory: [call({ callId: 'today' }), call({ callId: 'older', createdAt: older.toISOString() })],
    });

    const headings = tree.root.findAll(
      (n: any) => n.props?.testID === 'section-header' || n.props?.title === 'Today',
    );
    expect(headings.length).toBeGreaterThanOrEqual(1);
  });

  test('tapping a row opens the person hub instead of dialling', () => {
    const onOpenProfile = jest.fn();
    const onVideoCall = jest.fn();
    const tree = render({
      callHistory: [call()],
      onOpenProfile,
      onVideoCall,
    });

    const row = pressable(tree, 'call-history-row');
    act(() => {
      row.props.onPress();
    });

    expect(onOpenProfile).toHaveBeenCalledWith('user-bob');
    expect(onVideoCall).not.toHaveBeenCalled();
  });

  test('the peer is the caller for an incoming call', () => {
    const onOpenProfile = jest.fn();
    const tree = render({
      callHistory: [call({ direction: 'incoming' })],
      onOpenProfile,
    });

    act(() => {
      pressable(tree, 'call-history-row').props.onPress();
    });
    expect(onOpenProfile).toHaveBeenCalledWith('user-alice');
  });
});

describe('CallsScreen – redial modality', () => {
  afterEach(() => jest.clearAllMocks());

  test('redials an audio call as an audio call', () => {
    const onAudioCall = jest.fn();
    const onVideoCall = jest.fn();
    const tree = render({
      callHistory: [call({ mediaType: 'audio' })],
      onAudioCall,
      onVideoCall,
    });

    act(() => {
      pressable(tree, 'call-history-redial').props.onPress();
    });

    expect(onAudioCall).toHaveBeenCalledWith('user-bob');
    expect(onVideoCall).not.toHaveBeenCalled();
  });

  test('redials a video call as a video call', () => {
    const onAudioCall = jest.fn();
    const onVideoCall = jest.fn();
    const tree = render({
      callHistory: [call({ mediaType: 'video' })],
      onAudioCall,
      onVideoCall,
    });

    act(() => {
      pressable(tree, 'call-history-redial').props.onPress();
    });

    expect(onVideoCall).toHaveBeenCalledWith('user-bob');
    expect(onAudioCall).not.toHaveBeenCalled();
  });
});

describe('CallsScreen – All / Missed filter', () => {
  afterEach(() => jest.clearAllMocks());

  const history = [
    call({ callId: 'answered', direction: 'outgoing' }),
    call({ callId: 'missed', direction: 'incoming', status: 'missed', endReason: 'timeout' }),
  ];

  test('All shows every call', () => {
    const tree = render({ callHistory: history });
    expect(rowCount(tree, 'call-history-row')).toBe(2);
  });

  test('Missed narrows the log and announces the change', () => {
    const tree = render({ callHistory: history });

    const filter = byTestID(tree, 'calls-filter').find(
      (n: any) => typeof n.props?.onChange === 'function',
    );
    act(() => {
      filter.props.onChange('missed');
    });

    expect(rowCount(tree, 'call-history-row')).toBe(1);
    expect(announceForAccessibility).toHaveBeenCalledWith('Showing missed calls');
  });

  test('an empty Missed filter reads as "no missed calls", not "no calls yet"', () => {
    const tree = render({ callHistory: [call({ callId: 'answered' })] });

    const filter = byTestID(tree, 'calls-filter').find(
      (n: any) => typeof n.props?.onChange === 'function',
    );
    act(() => {
      filter.props.onChange('missed');
    });

    const empty = byTestID(tree, 'calls-empty').find((n: any) => typeof n.type === 'function');
    expect(empty.props.title).toBe('No missed calls');
  });
});

describe('CallsScreen – new call', () => {
  afterEach(() => jest.clearAllMocks());

  test('the FAB opens the people picker rather than a dial form', () => {
    const tree = render({ onSearchUsers: jest.fn().mockResolvedValue([]) });

    const picker = byTestID(tree, 'calls-people-picker').find(
      (n: any) => typeof n.type === 'function',
    );
    expect(picker.props.visible).toBe(false);

    act(() => {
      pressable(tree, 'calls-new-call').props.onPress();
    });

    const openPicker = byTestID(tree, 'calls-people-picker').find(
      (n: any) => typeof n.type === 'function',
    );
    expect(openPicker.props.visible).toBe(true);
  });

  test('picking a person asks audio or video, then dials that modality', () => {
    const onAudioCall = jest.fn();
    const tree = render({ onSearchUsers: jest.fn().mockResolvedValue([]), onAudioCall });

    const picker = byTestID(tree, 'calls-people-picker').find(
      (n: any) => typeof n.type === 'function',
    );
    act(() => {
      picker.props.onSelect('user-carol');
    });

    const sheet = byTestID(tree, 'calls-modality-sheet').find(
      (n: any) => typeof n.type === 'function',
    );
    expect(sheet.props.visible).toBe(true);

    act(() => {
      pressable(tree, 'calls-modality-audio').props.onPress();
    });
    expect(onAudioCall).toHaveBeenCalledWith('user-carol');
  });

  test('no room-join or dial affordances remain', () => {
    const tree = render({ callHistory: [call()] });
    ['lobby-call', 'input-callee-id', 'input-user-id', 'input-signaling-url', 'input-room-id', 'lobby-join-room', 'contact-directory', 'dismiss-summary', 'developer-tools-section']
      .forEach(testID => {
        expect(byTestID(tree, testID)).toHaveLength(0);
      });
  });
});

describe('CallsScreen – server unreachable', () => {
  afterEach(() => jest.clearAllMocks());

  test('explains the failure and offers a retry action', () => {
    const onRetryConnect = jest.fn();
    const tree = render({ isServerUnreachable: true, onRetryConnect });

    const banner = tree.root.find(
      (n: any) => typeof n.type === 'string' && n.props.testID === 'offline-banner',
    );
    expect(banner.props.accessibilityRole).toBe('alert');

    const retry = tree.root.find(
      (n: any) =>
        n.props?.testID === 'offline-banner-action' && typeof n.props.onPress === 'function',
    );
    act(() => {
      retry.props.onPress();
    });
    expect(onRetryConnect).toHaveBeenCalledTimes(1);
  });

  test('hides the banner while the server is reachable', () => {
    const tree = render();
    expect(byTestID(tree, 'offline-banner')).toHaveLength(0);
  });

  test('uses the shared offline sentence rather than its own wording', () => {
    const tree = render({ isServerUnreachable: true, onRetryConnect: jest.fn() });

    const texts = tree.root
      .findAll((n: any) => typeof n.type === 'string')
      .flatMap((n: any) =>
        (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children]).filter(
          (child: unknown) => typeof child === 'string',
        ),
      );
    expect(texts).toContain(describeOffline(OFFLINE_CONSEQUENCE.calls));
  });
});

describe('CallsScreen message action', () => {
  test('offers a swipe action that opens the conversation with the caller', () => {
    const onMessage = jest.fn();
    const tree = render({ callHistory: [call({ mediaType: 'audio' })], onMessage });

    act(() => {
      pressable(tree, 'call-history-message').props.onPress();
    });

    expect(onMessage).toHaveBeenCalledWith('user-bob');
  });

  test('omits the action when there is nowhere to navigate', () => {
    const tree = render({ callHistory: [call({ mediaType: 'audio' })] });
    expect(byTestID(tree, 'call-history-message')).toHaveLength(0);
  });
});
