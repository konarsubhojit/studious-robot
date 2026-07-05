import { _resetCallKeepCache } from '../src/callKeep';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

const mockCallKeep = {
  setup: jest.fn().mockResolvedValue(undefined),
  setAvailable: jest.fn(),
  displayIncomingCall: jest.fn(),
  setCurrentCallActive: jest.fn(),
  endCall: jest.fn(),
  endAllCalls: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};

describe('callKeep with the native module absent', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('react-native-callkeep', () => {
      throw new Error('missing native module');
    });
    _resetCallKeepCache();
  });

  afterEach(() => {
    jest.dontMock('react-native-callkeep');
  });

  test('loadCallKeep returns null and only warns once', () => {
    const { loadCallKeep: load, _resetCallKeepCache: reset } = require('../src/callKeep');
    reset();
    expect(load()).toBeNull();
    expect(load()).toBeNull();
    const { logWarn } = require('../src/appLogger');
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  test('all helpers degrade to a safe no-op', async () => {
    const mod = require('../src/callKeep');
    mod._resetCallKeepCache();
    await expect(mod.setupCallKeep()).resolves.toBe(false);
    await expect(mod.displayIncomingCall({ callId: 'c1' })).resolves.toBe(false);
    expect(mod.reportCallConnected('c1')).toBe(false);
    expect(mod.endCall('c1')).toBe(false);
    expect(mod.endAllCalls()).toBe(false);
    // Unsubscribe is always callable.
    expect(typeof mod.registerCallActionListeners({})).toBe('function');
  });
});

describe('callKeep with the native module present', () => {
  let mod;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('react-native-callkeep', () => ({ default: mockCallKeep }));
    mod = require('../src/callKeep');
    mod._resetCallKeepCache();
  });

  afterEach(() => {
    jest.dontMock('react-native-callkeep');
  });

  test('loadCallKeep resolves the default export', () => {
    expect(mod.loadCallKeep()).toBe(mockCallKeep);
  });

  test('setupCallKeep configures once and marks available on Android', async () => {
    await expect(mod.setupCallKeep()).resolves.toBe(true);
    await expect(mod.setupCallKeep()).resolves.toBe(true);
    expect(mockCallKeep.setup).toHaveBeenCalledTimes(1);
    expect(mockCallKeep.setAvailable).toHaveBeenCalledWith(true);
  });

  test('displayIncomingCall shows the system UI with caller details', async () => {
    await expect(
      mod.displayIncomingCall({ callId: 'call-1', callerId: 'alice' }),
    ).resolves.toBe(true);
    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledWith(
      'call-1',
      'alice',
      'alice',
      'generic',
      true,
    );
  });

  test('displayIncomingCall returns false without a callId', async () => {
    await expect(mod.displayIncomingCall({})).resolves.toBe(false);
    expect(mockCallKeep.displayIncomingCall).not.toHaveBeenCalled();
  });

  test('reportCallConnected / endCall / endAllCalls delegate to the module', () => {
    expect(mod.reportCallConnected('call-1')).toBe(true);
    expect(mockCallKeep.setCurrentCallActive).toHaveBeenCalledWith('call-1');
    expect(mod.endCall('call-1')).toBe(true);
    expect(mockCallKeep.endCall).toHaveBeenCalledWith('call-1');
    expect(mod.endAllCalls()).toBe(true);
    expect(mockCallKeep.endAllCalls).toHaveBeenCalled();
  });

  test('registerCallActionListeners bridges answer/end events', () => {
    const onAnswer = jest.fn();
    const onEnd = jest.fn();
    const unsubscribe = mod.registerCallActionListeners({ onAnswer, onEnd });

    expect(mockCallKeep.addEventListener).toHaveBeenCalledWith('answerCall', expect.any(Function));
    expect(mockCallKeep.addEventListener).toHaveBeenCalledWith('endCall', expect.any(Function));

    const answerCb = mockCallKeep.addEventListener.mock.calls.find((c) => c[0] === 'answerCall')[1];
    const endCb = mockCallKeep.addEventListener.mock.calls.find((c) => c[0] === 'endCall')[1];
    answerCb({ callUUID: 'call-1' });
    endCb({ callUUID: 'call-1' });
    expect(onAnswer).toHaveBeenCalledWith('call-1');
    expect(onEnd).toHaveBeenCalledWith('call-1');

    unsubscribe();
    expect(mockCallKeep.removeEventListener).toHaveBeenCalledWith('answerCall');
    expect(mockCallKeep.removeEventListener).toHaveBeenCalledWith('endCall');
  });
});
