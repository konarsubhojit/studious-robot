import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useAppSettings from '../../src/hooks/useAppSettings';

jest.mock('../../src/settingsStorage', () => ({
  loadSettings: jest.fn(async defaults => ({ ...defaults })),
  saveSettings: jest.fn(async () => true),
}));

jest.mock('../../src/webrtcConfig', () => ({
  ICE_TRANSPORT_POLICIES: { ALL: 'all', RELAY: 'relay' },
  normalizeIceTransportPolicy: jest.fn(value => (value === 'relay' ? 'relay' : 'all')),
  resetIceServersForCallCache: jest.fn(),
}));

function TestHook({ resultRef, onStatus }: any) {
  resultRef.current = useAppSettings({ onStatus });
  return null;
}

describe('useAppSettings', () => {
  afterEach(() => jest.clearAllMocks());

  test('resets cached ICE credentials when the transport policy changes', async () => {
    const resultRef: { current: any; } = { current: null };
    const onStatus = jest.fn();
    let tree: any;
    await act(async () => {
      tree = renderer.create(<TestHook resultRef={resultRef} onStatus={onStatus} />);
    });

    await act(async () => {
      resultRef.current.handleIceTransportPolicyChange('relay');
    });
    act(() => {
      tree.update(<TestHook resultRef={resultRef} onStatus={onStatus} />);
    });

    const { saveSettings } = require('../../src/settingsStorage');
    const { resetIceServersForCallCache } = require('../../src/webrtcConfig');
    expect(resetIceServersForCallCache).toHaveBeenCalledTimes(1);
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ iceTransportPolicy: 'relay' }),
    );
    expect(onStatus).toHaveBeenCalledWith('TURN relay forced for new calls');
  });
});
