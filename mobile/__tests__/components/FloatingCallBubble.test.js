import React from 'react';
import renderer, { act } from 'react-test-renderer';
import FloatingCallBubble from '../../src/components/FloatingCallBubble';

jest.mock('../../src/components/IconButton', () => (props) =>
  require('react').createElement('IconButton', props),
);

function findByTestId(tree, testID) {
  return tree.root.findAll((node) => node.props?.testID === testID)[0] ?? null;
}

function render(props) {
  let tree;
  act(() => {
    tree = renderer.create(
      <FloatingCallBubble
        participantLabel="Call with user-bob"
        elapsedCallSeconds={65}
        isMuted={false}
        isScreenSharing={false}
        onExpand={jest.fn()}
        onMuteToggle={jest.fn()}
        onEndCall={jest.fn()}
        onStopScreenShare={jest.fn()}
        {...props}
      />,
    );
  });
  return tree;
}

describe('FloatingCallBubble', () => {
  test('renders the participant label and formatted duration', () => {
    const tree = render();
    const text = tree.root.findAll((n) => n.props?.children === '01:05');
    expect(text.length).toBeGreaterThan(0);
    const label = tree.root.findAll((n) => n.props?.children === 'Call with user-bob');
    expect(label.length).toBeGreaterThan(0);
  });

  test('falls back to a generic label when participantLabel is null', () => {
    const tree = render({ participantLabel: null });
    const label = tree.root.findAll((n) => n.props?.children === 'Call in progress');
    expect(label.length).toBeGreaterThan(0);
  });

  test('tapping the bubble body calls onExpand', () => {
    const onExpand = jest.fn();
    const tree = render({ onExpand });
    act(() => {
      findByTestId(tree, 'floating-call-bubble-expand').props.onPress();
    });
    expect(onExpand).toHaveBeenCalled();
  });

  test('tapping mute calls onMuteToggle', () => {
    const onMuteToggle = jest.fn();
    const tree = render({ onMuteToggle });
    act(() => {
      findByTestId(tree, 'floating-call-bubble-mute').props.onPress();
    });
    expect(onMuteToggle).toHaveBeenCalled();
  });

  test('tapping end call calls onEndCall', () => {
    const onEndCall = jest.fn();
    const tree = render({ onEndCall });
    act(() => {
      findByTestId(tree, 'floating-call-bubble-end').props.onPress();
    });
    expect(onEndCall).toHaveBeenCalled();
  });

  test('stop-share button only renders when isScreenSharing is true', () => {
    const notSharing = render({ isScreenSharing: false });
    expect(findByTestId(notSharing, 'floating-call-bubble-stop-share')).toBeNull();

    const onStopScreenShare = jest.fn();
    const sharing = render({ isScreenSharing: true, onStopScreenShare });
    const stopShareButton = findByTestId(sharing, 'floating-call-bubble-stop-share');
    expect(stopShareButton).not.toBeNull();
    act(() => {
      stopShareButton.props.onPress();
    });
    expect(onStopScreenShare).toHaveBeenCalled();
  });
});
