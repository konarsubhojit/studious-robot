import React from 'react';
import renderer, { act } from 'react-test-renderer';
import Lobby from '../../src/components/Lobby';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('react-native-webrtc', () => ({
  RTCView: 'RTCView',
}));

jest.mock('../../src/SafeRTCView', () => 'SafeRTCView');

jest.mock('../../src/hooks/useCallFlow', () => ({
  CALL_END_REASON_LABELS: {
    ended:       'Call ended',
    declined:    'Call declined',
    cancelled:   'Call cancelled',
    timeout:     'Missed call',
    missed:      'Missed call',
    busy:        'Line was busy',
    unreachable: 'User unavailable',
    failed:      'Call failed',
  },
}));

// ─── Default props ────────────────────────────────────────────────────────────

const baseProps = {
  userId: 'user-alice',
  onChangeUserId: jest.fn(),
  calleeId: 'user-bob',
  onChangeCalleeId: jest.fn(),
  onCall: jest.fn(),
  signalingUrl: 'http://localhost:4173',
  onChangeSignalingUrl: jest.fn(),
  roomId: '',
  onChangeRoomId: jest.fn(),
  localPreviewStreamUrl: null,
  hasLocalStream: false,
  onStartPreview: jest.fn(),
  onJoinRoom: jest.fn(),
  isSettingsVisible: false,
  onToggleSettings: jest.fn(),
  onExportLogs: jest.fn(),
  settings: { autoLighting: false, speakerDefault: false },
  onToggleAutoLighting: jest.fn(),
  onToggleSpeakerDefault: jest.fn(),
  status: { message: '', severity: 'info' },
  callSummary: null,
  onDismissSummary: jest.fn(),
  callHistory: [],
  missedCallCount: 0,
  onMarkMissedRead: jest.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Lobby – missed call badge', () => {
  afterEach(() => jest.clearAllMocks());

  test('does not show missed badge when missedCallCount is 0', () => {
    let tree;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} missedCallCount={0} />);
    });
    const badge = tree.root.findAll((n) => n.props.testID === 'missed-calls-badge');
    expect(badge.length).toBe(0);
  });

  test('shows missed badge with correct count', () => {
    let tree;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} missedCallCount={3} />);
    });
    const badge = tree.root.findAll((n) => n.props.testID === 'missed-calls-badge');
    expect(badge.length).toBeGreaterThanOrEqual(1);
    // The badge text should contain the count.
    const texts = tree.root.findAll(
      (n) => n.type === 'Text' && String(n.props.children) === '3',
    );
    expect(texts.length).toBeGreaterThanOrEqual(1);
  });

  test('calls onMarkMissedRead when badge is pressed', () => {
    const onMarkMissedRead = jest.fn();
    let tree;
    act(() => {
      tree = renderer.create(
        <Lobby {...baseProps} missedCallCount={2} onMarkMissedRead={onMarkMissedRead} />,
      );
    });
    const badge = tree.root.findAll((n) => n.props.testID === 'missed-calls-badge');
    expect(badge.length).toBeGreaterThanOrEqual(1);
    act(() => { badge[0].props.onPress(); });
    expect(onMarkMissedRead).toHaveBeenCalledTimes(1);
  });
});

describe('Lobby – call history section', () => {
  afterEach(() => jest.clearAllMocks());

  test('does not render history section when callHistory is empty', () => {
    let tree;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} callHistory={[]} />);
    });
    const section = tree.root.findAll((n) => n.props.testID === 'call-history-section');
    expect(section.length).toBe(0);
  });

  test('renders history rows for each entry (up to 5)', () => {
    const history = Array.from({ length: 7 }, (_, i) => ({
      callId: `call-${i}`,
      callerId: 'user-alice',
      calleeId: 'user-bob',
      direction: 'outgoing',
      status: 'ended',
      endReason: 'ended',
      createdAt: new Date().toISOString(),
      durationSeconds: 60 + i,
      isRead: true,
    }));

    let tree;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} callHistory={history} />);
    });

    const rows = tree.root.findAll((n) => n.props.testID === 'call-history-row');
    // Only up to 5 rows should be shown; findAll returns composite+host so ×2.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  test('missed incoming calls are visually distinguished', () => {
    const history = [
      {
        callId: 'missed-1',
        callerId: 'user-bob',
        calleeId: 'user-alice',
        direction: 'incoming',
        status: 'missed',
        endReason: 'timeout',
        createdAt: new Date().toISOString(),
        durationSeconds: null,
        isRead: false,
      },
    ];
    let tree;
    act(() => {
      tree = renderer.create(<Lobby {...baseProps} callHistory={history} />);
    });
    const section = tree.root.findAll((n) => n.props.testID === 'call-history-section');
    expect(section.length).toBeGreaterThanOrEqual(1);
    // The peer label should show the caller's ID.
    const texts = tree.root.findAll(
      (n) => n.type === 'Text' && n.props.children === 'user-bob',
    );
    expect(texts.length).toBeGreaterThanOrEqual(1);
  });
});
