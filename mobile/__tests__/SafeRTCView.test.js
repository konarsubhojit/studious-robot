import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SafeRTCView from '../src/SafeRTCView';
import { logError } from '../src/appLogger';

let mockShouldThrow = false;

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
}));

jest.mock('react-native-webrtc', () => ({
  RTCView: jest.fn((props) => {
    if (mockShouldThrow) {
      throw new Error('RTCView boom');
    }

    return require('react').createElement('RTCView', props);
  }),
}));

describe('SafeRTCView', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    mockShouldThrow = false;
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('renders the underlying RTCView when given a valid streamURL', () => {
    let tree;
    act(() => {
      tree = renderer.create(
        <SafeRTCView streamURL="stream-1" objectFit="cover" mirror style={{ height: 200 }} />,
      );
    });

    const rtcView = tree.root.findByType('RTCView');
    expect(rtcView.props.streamURL).toBe('stream-1');
    expect(rtcView.props.objectFit).toBe('cover');
    expect(rtcView.props.mirror).toBe(true);
  });

  test('renders the fallback text when streamURL is empty', () => {
    let tree;
    act(() => {
      tree = renderer.create(<SafeRTCView streamURL={null} />);
    });

    expect(tree.root.findByType(Text).props.children).toBe('No video stream');
  });

  test('renders the fallback when RTCView throws and logs the error', () => {
    mockShouldThrow = true;

    let tree;
    act(() => {
      tree = renderer.create(
        <SafeRTCView fallbackLabel="Preview unavailable" streamURL="stream-1" />,
      );
    });

    expect(tree.root.findByType(Text).props.children).toBe('Preview unavailable');
    expect(logError).toHaveBeenCalledWith(
      'SafeRTCView render failure',
      expect.objectContaining({
        message: 'RTCView boom',
        stack: expect.any(String),
      }),
    );
  });

  test('recovers when streamURL changes after an error', () => {
    mockShouldThrow = true;
    let tree;
    act(() => {
      tree = renderer.create(<SafeRTCView streamURL="stream-1" />);
    });

    mockShouldThrow = false;
    act(() => {
      tree.update(<SafeRTCView streamURL="stream-2" />);
    });

    expect(tree.root.findByType('RTCView').props.streamURL).toBe('stream-2');
  });
});
