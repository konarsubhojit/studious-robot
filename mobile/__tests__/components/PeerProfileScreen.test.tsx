import React from 'react';
import renderer, { act } from 'react-test-renderer';
import PeerProfileScreen from '../../src/components/PeerProfileScreen';

function findByTestId(/** @type {any} */ tree: any, /** @type {any} */ testID: any) {
  return tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === testID && typeof node.type === 'string')[0] ?? null;
}

function findAllByTestId(/** @type {any} */ tree: any, /** @type {any} */ testID: any) {
  return tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === testID && typeof node.type === 'string');
}

function press(/** @type {any} */ tree: any, /** @type {any} */ testID: any) {
  const pressable = tree.root.findAll(
    (/** @type {any} */ node: any) => node.props?.testID === testID && typeof node.props?.onPress === 'function',
  )[0];
  act(() => {
    pressable.props.onPress();
  });
}

function render(/** @type {any} */ props: any) {
  /** @type {any} */
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

  test('hides the mute row when no handler is supplied', () => {
    expect(findByTestId(render({}), 'peer-profile-mute')).toBeNull();
    expect(findByTestId(render({ onToggleMute: jest.fn() }), 'peer-profile-mute')).not.toBeNull();
  });
});
