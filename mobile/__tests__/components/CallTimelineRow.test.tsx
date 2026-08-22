// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import CallTimelineRow, {
  formatCallDuration,
  formatCallEntryLabel,
} from '../../src/components/CallTimelineRow';

function makeCall(overrides = {}) {
  return {
    type: 'call',
    callId: 'call-1',
    conversationId: 'conv-1',
    direction: 'outgoing',
    status: 'ended',
    endReason: 'ended',
    durationSeconds: 128,
    createdAt: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

function render(/** @type {any} */ props: any) {
  /** @type {any} */
  let tree: any;
  act(() => {
    tree = renderer.create(<CallTimelineRow {...props} />);
  });
  return tree;
}

function findAllByTestIdPrefix(/** @type {any} */ tree: any, /** @type {any} */ prefix: any) {
  return tree.root.findAll(
    (/** @type {any} */ node: any) =>
      typeof node.type === 'string' &&
      typeof node.props?.testID === 'string' &&
      node.props.testID.startsWith(prefix),
  );
}

describe('formatCallDuration', () => {
  test('formats minutes and seconds, and hours when needed', () => {
    expect(formatCallDuration(128)).toBe('2:08');
    expect(formatCallDuration(59)).toBe('0:59');
    expect(formatCallDuration(3661)).toBe('1:01:01');
  });

  test('renders nothing for a call that never connected', () => {
    expect(formatCallDuration(0)).toBe('');
    expect(formatCallDuration(null)).toBe('');
    expect(formatCallDuration(undefined)).toBe('');
  });
});

describe('formatCallEntryLabel', () => {
  test('describes direction, outcome and duration', () => {
    expect(formatCallEntryLabel(makeCall())).toBe('Outgoing call · 2:08');
    expect(
      formatCallEntryLabel(makeCall({ direction: 'incoming', status: 'missed', durationSeconds: 0 })),
    ).toBe('Missed call');
    expect(
      formatCallEntryLabel(makeCall({ direction: 'outgoing', status: 'declined', durationSeconds: 0 })),
    ).toBe('Declined');
  });
});

describe('CallTimelineRow', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders a single call with its label', () => {
    const tree = render({ entries: [makeCall()], peerId: 'user-bob' });
    const row = tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === 'chat-call-entry')[0];
    expect(row.props.accessibilityLabel).toBe('Outgoing call · 2:08');
  });

  test('collapses a run of same-outcome calls and expands on tap', () => {
    const entries = [
      makeCall({ callId: 'c1', direction: 'incoming', status: 'missed', durationSeconds: 0 }),
      makeCall({ callId: 'c2', direction: 'incoming', status: 'missed', durationSeconds: 0 }),
      makeCall({ callId: 'c3', direction: 'incoming', status: 'missed', durationSeconds: 0 }),
    ];
    const tree = render({ entries, peerId: 'user-bob' });

    const collapsed = tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === 'chat-call-entry')[0];
    expect(collapsed.props.accessibilityLabel).toBe('3 missed calls');

    act(() => {
      collapsed.props.onPress();
    });

    expect(findAllByTestIdPrefix(tree, 'chat-call-entry')).toHaveLength(3);
  });

  test('offers to call the peer back, by audio or video', () => {
    const onCallBack = jest.fn();
    const onVideoCallBack = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const tree = render({ entries: [makeCall()], peerId: 'user-bob', onCallBack, onVideoCallBack });
    act(() => {
      tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === 'chat-call-entry')[0].props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const buttons = /** @type {any[]} */ (alertSpy.mock.calls[0][2]);
    expect(buttons.map(button => button.text)).toEqual([
      'Call back',
      'Video call back',
      'Cancel',
    ]);

    buttons[0].onPress();
    buttons[1].onPress();
    expect(onCallBack).toHaveBeenCalledWith('user-bob');
    expect(onVideoCallBack).toHaveBeenCalledWith('user-bob');
  });

  test('does not offer a call back when no handler is provided', () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = render({ entries: [makeCall()], peerId: 'user-bob' });
    act(() => {
      tree.root.findAll((/** @type {any} */ node: any) => node.props?.testID === 'chat-call-entry')[0].props.onPress();
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
