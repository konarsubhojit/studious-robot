import React from 'react';
import renderer, { act } from 'react-test-renderer';
import PeerProfileScreen from '../../src/components/PeerProfileScreen';

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID && typeof node.type === 'string')[0] ?? null;
}

function findAllByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID && typeof node.type === 'string');
}

function press(tree: any, testID: any) {
  const pressable = tree.root.findAll(
    (node: any) => node.props?.testID === testID && typeof node.props?.onPress === 'function',
  )[0];
  act(() => {
    pressable.props.onPress();
  });
}

function render(props: any) {
  let tree: any;
  act(() => {
    tree = renderer.create(<PeerProfileScreen peerId="user-bob" {...props} />);
  });
  return tree;
}

describe('PeerProfileScreen', () => {
  test('renders presence and the primary actions', () => {
    const tree = render({ presence: { online: true } });

    expect(findByTestId(tree, 'peer-profile-root')).not.toBeNull();
    expect(findByTestId(tree, 'peer-profile-presence')).not.toBeNull();
    expect(findByTestId(tree, 'peer-profile-message')).not.toBeNull();
    expect(findByTestId(tree, 'peer-profile-audio-call')).not.toBeNull();
    expect(findByTestId(tree, 'peer-profile-video-call')).not.toBeNull();
  });

  test('lists only the calls with this peer', () => {
    const tree = render({
      currentUserId: 'user-me',
      callHistory: [
        { callId: 'call-1', direction: 'outgoing', calleeId: 'user-bob' },
        { callId: 'call-2', direction: 'outgoing', calleeId: 'user-carol' },
        { callId: 'call-3', direction: 'incoming', callerId: 'user-bob', status: 'missed' },
      ],
    });

    expect(findAllByTestId(tree, 'peer-profile-call-row')).toHaveLength(2);
    expect(findByTestId(tree, 'peer-profile-no-calls')).toBeNull();
  });

  test('shows an empty state when there are no calls with this peer', () => {
    const tree = render({ callHistory: [] });
    expect(findByTestId(tree, 'peer-profile-no-calls')).not.toBeNull();
  });

  test('blocks the peer and offers the reverse once blocked', async () => {
    const onBlock = jest.fn().mockResolvedValue(true);
    const onUnblock = jest.fn().mockResolvedValue(true);

    const tree = render({ onBlock, onUnblock });
    press(tree, 'peer-profile-block');
    await act(async () => {});

    expect(onBlock).toHaveBeenCalledWith('user-bob');
    expect(onUnblock).not.toHaveBeenCalled();

    act(() => {
      tree.update(
        <PeerProfileScreen peerId="user-bob" isBlocked onBlock={onBlock} onUnblock={onUnblock} />,
      );
    });
    expect(findByTestId(tree, 'peer-profile-blocked-note')).not.toBeNull();

    press(tree, 'peer-profile-block');
    await act(async () => {});
    expect(onUnblock).toHaveBeenCalledWith('user-bob');
  });

  test('invokes the call and message handlers with the peer id', () => {
    const onMessage = jest.fn();
    const onAudioCall = jest.fn();
    const onVideoCall = jest.fn();
    const tree = render({ onMessage, onAudioCall, onVideoCall });

    press(tree, 'peer-profile-message');
    press(tree, 'peer-profile-audio-call');
    press(tree, 'peer-profile-video-call');

    expect(onMessage).toHaveBeenCalledWith('user-bob');
    expect(onAudioCall).toHaveBeenCalledWith('user-bob');
    expect(onVideoCall).toHaveBeenCalledWith('user-bob');
  });

  test('the mute row is always present and reports its state', () => {
    // It used to render only when an `onToggleMute` prop was supplied, and
    // nothing ever supplied one — mute existed in the code, never in the app.
    const muteRow = (tree: any) =>
      tree.root.findAll(
        (node: any) => node.props?.testID === 'peer-profile-mute' && typeof node.type === 'string',
      )[0];

    expect(muteRow(render({}))).not.toBeNull();
    expect(muteRow(render({ isMuted: true })).props.accessibilityState).toEqual({
      checked: true,
      disabled: false,
    });
    expect(muteRow(render({ isMuted: false })).props.accessibilityState).toEqual({
      checked: false,
      disabled: false,
    });
  });

  test('toggling mute reports the peer it applies to', () => {
    const onToggleMute = jest.fn();
    press(render({ onToggleMute }), 'peer-profile-mute');
    expect(onToggleMute).toHaveBeenCalledWith('user-bob');
  });

  test('does not offer a report control while nothing can receive a report', () => {
    // The row used to answer with an `Alert` promising the report would be
    // reviewed; no endpoint exists, so the row is gone until one does.
    expect(findByTestId(render({}), 'peer-profile-report')).toBeNull();
  });

  test('primary actions are disabled while the peer is blocked', () => {
    const tree = render({
      isBlocked: true,
      onMessage: jest.fn(),
      onAudioCall: jest.fn(),
      onVideoCall: jest.fn(),
    });

    ['peer-profile-message', 'peer-profile-audio-call', 'peer-profile-video-call'].forEach(id => {
      const control = tree.root.findAll(
        (node: any) => node.props?.testID === id && typeof node.type === 'string',
      )[0];
      expect(control.props.accessibilityState.disabled).toBe(true);
    });
  });

  test('describes a call with the same vocabulary as the call log', () => {
    const tree = render({
      currentUserId: 'user-me',
      callHistory: [
        {
          callId: 'call-1',
          direction: 'incoming',
          callerId: 'user-bob',
          status: 'missed',
          createdAt: '2026-01-01T09:30:00.000Z',
        },
      ],
    });

    const titles = tree.root
      .findAll((node: any) => node.type === 'Text')
      .map((node: any) => node.props.children)
      .filter((child: any) => typeof child === 'string');

    // `describeCallOutcome`, not the screen's own copy of the same phrasing.
    expect(titles).toContain('Missed call');
  });
});
