// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useCallInitiation from '../../src/hooks/useCallInitiation';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

const { logError } = require('../../src/appLogger');

function TestHook(/** @type {any} */ { resultRef, params }) {
  resultRef.current = useCallInitiation(params);
  return null;
}

function setup(overrides = {}) {
  const params = {
    isInCall: false,
    setCalleeId: jest.fn(),
    placeCall: jest.fn(async () => {}),
    handleVideoToggle: jest.fn(),
    ...overrides,
  };
  /** @type {{ current: any }} */
  const resultRef = { current: null };
  /** @type {any} */
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params, tree };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useCallInitiation', () => {
  test('startVideoCallWith sets the calleeId and places a call', async () => {
    const { resultRef, params } = setup();
    await act(async () => {
      resultRef.current.startVideoCallWith('bob');
      await Promise.resolve();
    });
    expect(params.setCalleeId).toHaveBeenCalledWith('bob');
    expect(params.placeCall).toHaveBeenCalledWith('bob');
  });

  test('startVideoCallWith logs an error when placeCall rejects', async () => {
    const params = {
      placeCall: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const { resultRef } = setup(params);
    await act(async () => {
      resultRef.current.startVideoCallWith('bob');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(logError).toHaveBeenCalledWith('placeCall (video) failed', expect.any(Error));
  });

  test('startAudioCallWith turns off the camera once the call connects', async () => {
    const { resultRef, params, tree } = setup({ isInCall: false });

    await act(async () => {
      resultRef.current.startAudioCallWith('bob');
      await Promise.resolve();
    });
    expect(params.setCalleeId).toHaveBeenCalledWith('bob');
    expect(params.placeCall).toHaveBeenCalledWith('bob');
    expect(params.handleVideoToggle).not.toHaveBeenCalled();

    act(() => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, isInCall: true }} />);
    });

    expect(params.handleVideoToggle).toHaveBeenCalledTimes(1);
  });

  test('does not toggle video when isInCall flips true without a pending audio-only call', () => {
    const { params, tree, resultRef } = setup({ isInCall: false });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} params={{ ...params, isInCall: true }} />);
    });
    expect(params.handleVideoToggle).not.toHaveBeenCalled();
  });

  test('startAudioCallWith logs an error when placeCall rejects', async () => {
    const params = {
      placeCall: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const { resultRef } = setup(params);
    await act(async () => {
      resultRef.current.startAudioCallWith('bob');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(logError).toHaveBeenCalledWith('placeCall (audio) failed', expect.any(Error));
  });
});
