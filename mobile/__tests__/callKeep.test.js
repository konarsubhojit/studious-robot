import { _resetCallKeepCache } from '../src/callKeep';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

const mockShowIncomingCallNotification = jest.fn().mockResolvedValue(true);
const mockDismissIncomingCallNotification = jest.fn();
jest.mock('../src/incomingCallNotification', () => ({
  showIncomingCallNotification: (...args) => mockShowIncomingCallNotification(...args),
  dismissIncomingCallNotification: (...args) => mockDismissIncomingCallNotification(...args),
}));

const mockStartIncomingRingtone = jest.fn();
const mockStopIncomingRingtone = jest.fn();
jest.mock('../src/ringtone', () => ({
  startIncomingRingtone: (...args) => mockStartIncomingRingtone(...args),
  stopIncomingRingtone: (...args) => mockStopIncomingRingtone(...args),
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
    await expect(mod.displayIncomingCall({ callId: 'c1' })).resolves.toEqual({
      shown: false,
      reason: 'native_module_absent',
    });
    expect(mod.reportCallConnected('c1')).toBe(false);
    expect(mod.endCall('c1')).toBe(false);
    expect(mod.endAllCalls()).toBe(false);
    // Unsubscribe is always callable.
    expect(typeof mod.registerCallActionListeners()).toBe('function');
    expect(typeof mod.registerShowIncomingCallUiListener()).toBe('function');
    // Attaching handlers is safe even with no native module to route events
    // from; it just never gets to fire them.
    expect(typeof mod.setCallActionHandlers({})).toBe('function');
  });
});

describe('callKeep with the native module present', () => {
  let mod;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete mockCallKeep.hasPhoneAccount;
    delete mockCallKeep.checkPhoneAccountEnabled;
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

  test('setupCallKeep requests a self-managed phone account, with a showIncomingCallUi handler to back it', async () => {
    // Self-managed lets WeTalk draw its own branded incoming-call UI instead
    // of the generic system dialer, but only because
    // `registerShowIncomingCallUiListener` (asserted below) exists to answer
    // the `showIncomingCallUi` event Telecom fires in place of its own UI —
    // flipping this back to self-managed without that handler is exactly the
    // regression that silenced incoming calls previously.
    await mod.setupCallKeep();
    const [options] = mockCallKeep.setup.mock.calls[0];
    expect(options.android.selfManaged).toBe(true);
  });

  test('setupCallKeep survives the Activity-less background push context', async () => {
    // A push that cold-starts the app has no foreground Activity, so CallKeep's
    // phone-account permission prompt rejects after the native setup succeeded.
    mockCallKeep.setup.mockRejectedValueOnce(
      Object.assign(new Error("Activity doesn't exist"), { code: 'E_ACTIVITY_DOES_NOT_EXIST' }),
    );
    await expect(mod.setupCallKeep()).resolves.toBe(true);
    expect(mockCallKeep.setAvailable).toHaveBeenCalledWith(true);
  });

  test('setupCallKeep still fails on a genuine setup error', async () => {
    mockCallKeep.setup.mockRejectedValueOnce(new Error('boom'));
    await expect(mod.setupCallKeep()).resolves.toBe(false);
  });

  test('a new call from the same caller replaces the stale ring', async () => {
    await mod.displayIncomingCall({ callId: 'call-old', callerId: 'alice' });
    mockCallKeep.endCall.mockClear();
    mockDismissIncomingCallNotification.mockClear();

    await expect(
      mod.displayIncomingCall({ callId: 'call-new', callerId: 'alice' }),
    ).resolves.toEqual({ shown: true });

    // The cancelled call's UI must not stay on screen next to the redial,
    // where a tap would answer a call that no longer exists.
    expect(mockCallKeep.endCall).toHaveBeenCalledWith('call-old');
    expect(mockDismissIncomingCallNotification).toHaveBeenCalledWith('call-old');
    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledWith(
      'call-new',
      'alice',
      'alice',
      'generic',
      true,
    );
  });

  test('a call from a different caller leaves an existing ring alone', async () => {
    await mod.displayIncomingCall({ callId: 'call-alice', callerId: 'alice' });
    mockCallKeep.endCall.mockClear();

    await mod.displayIncomingCall({ callId: 'call-bob', callerId: 'bob' });

    expect(mockCallKeep.endCall).not.toHaveBeenCalled();
  });

  test('displayIncomingCall shows the system UI with caller details', async () => {
    await expect(mod.displayIncomingCall({ callId: 'call-1', callerId: 'alice' })).resolves.toEqual(
      { shown: true },
    );
    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledWith(
      'call-1',
      'alice',
      'alice',
      'generic',
      true,
    );
  });

  test('displayIncomingCall ignores a duplicate ring for the same call', async () => {
    await expect(mod.displayIncomingCall({ callId: 'dup-1', callerId: 'alice' })).resolves.toEqual({
      shown: true,
    });
    // A second path (foreground push racing the socket event) rings the same call.
    await expect(mod.displayIncomingCall({ callId: 'dup-1', callerId: 'alice' })).resolves.toEqual({
      shown: false,
      reason: 'duplicate_callId_deduped',
    });
    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledTimes(1);
  });

  test('displayIncomingCall rings again after the call was ended', async () => {
    await mod.displayIncomingCall({ callId: 'again-1', callerId: 'alice' });
    mod.endCall('again-1');
    await mod.displayIncomingCall({ callId: 'again-1', callerId: 'alice' });
    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledTimes(2);
  });

  test('displayIncomingCall returns false without a callId', async () => {
    await expect(mod.displayIncomingCall({})).resolves.toEqual({
      shown: false,
      reason: 'missing_call_id',
    });
    expect(mockCallKeep.displayIncomingCall).not.toHaveBeenCalled();
  });

  test('displayIncomingCall reports a disabled phone account', async () => {
    mockCallKeep.checkPhoneAccountEnabled = jest.fn().mockResolvedValueOnce(false);
    await expect(
      mod.displayIncomingCall({ callId: 'disabled-1', callerId: 'alice' }),
    ).resolves.toEqual({
      shown: false,
      reason: 'phone_account_disabled_by_user',
    });
    delete mockCallKeep.checkPhoneAccountEnabled;
  });

  test('displayIncomingCall reports an unregistered phone account', async () => {
    mockCallKeep.hasPhoneAccount = jest.fn().mockResolvedValueOnce(false);
    await expect(
      mod.displayIncomingCall({ callId: 'unregistered-1', callerId: 'alice' }),
    ).resolves.toEqual({
      shown: false,
      reason: 'phone_account_not_registered',
    });
    delete mockCallKeep.hasPhoneAccount;
  });

  test('displayIncomingCall reports Telecom exceptions', async () => {
    mockCallKeep.displayIncomingCall.mockImplementationOnce(() => {
      throw new Error('telecom unavailable');
    });
    await expect(
      mod.displayIncomingCall({ callId: 'throw-1', callerId: 'alice' }),
    ).resolves.toEqual({
      shown: false,
      reason: 'telecom_threw',
      message: 'telecom unavailable',
    });
  });

  test('reportCallConnected / endCall / endAllCalls delegate to the module', () => {
    expect(mod.reportCallConnected('call-1')).toBe(true);
    expect(mockCallKeep.setCurrentCallActive).toHaveBeenCalledWith('call-1');
    expect(mod.endCall('call-1')).toBe(true);
    expect(mockCallKeep.endCall).toHaveBeenCalledWith('call-1');
    expect(mod.endAllCalls()).toBe(true);
    expect(mockCallKeep.endAllCalls).toHaveBeenCalled();
  });

  test('registerCallActionListeners subscribes once, at module scope', () => {
    const unregister = mod.registerCallActionListeners();

    expect(mockCallKeep.addEventListener).toHaveBeenCalledWith('answerCall', expect.any(Function));
    expect(mockCallKeep.addEventListener).toHaveBeenCalledWith('endCall', expect.any(Function));
    expect(typeof unregister).toBe('function');
  });

  test('answerCall received with no call flow attached is queued, not dropped', () => {
    mod.registerCallActionListeners();
    const answerCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'answerCall')[1];

    // Simulates the OS Answer button being tapped during a push cold start,
    // before `useCallFlow` has mounted and called `setCallActionHandlers`.
    answerCb({ callUUID: 'call-1' });

    const onAnswer = jest.fn();
    mod.setCallActionHandlers({ onAnswer, onEnd: jest.fn() });

    // The queued intent is replayed the instant a handler attaches.
    expect(onAnswer).toHaveBeenCalledWith('call-1');
  });

  test('setCallActionHandlers routes subsequent events directly once attached', () => {
    mod.registerCallActionListeners();
    const onAnswer = jest.fn();
    const onEnd = jest.fn();
    mod.setCallActionHandlers({ onAnswer, onEnd });

    const answerCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'answerCall')[1];
    const endCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'endCall')[1];
    answerCb({ callUUID: 'call-2' });
    endCb({ callUUID: 'call-2' });

    expect(onAnswer).toHaveBeenCalledWith('call-2');
    expect(onEnd).toHaveBeenCalledWith('call-2');
  });

  test('detaching call action handlers leaves the native listener registered', () => {
    const unregisterModuleScope = mod.registerCallActionListeners();
    const detach = mod.setCallActionHandlers({ onAnswer: jest.fn(), onEnd: jest.fn() });

    detach();

    // Only the handler hand-off was detached; react-native-callkeep tracks a
    // single listener per event name and unsubscribes by name only, so a
    // consumer (e.g. useCallFlow) unmounting must never remove the
    // module-scope subscription wired by `registerCallActionListeners`.
    expect(mockCallKeep.removeEventListener).not.toHaveBeenCalled();

    // A later event with nothing attached is queued again, exactly like the
    // original push-cold-start race.
    const answerCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'answerCall')[1];
    const onAnswer = jest.fn();
    answerCb({ callUUID: 'call-3' });
    mod.setCallActionHandlers({ onAnswer, onEnd: jest.fn() });
    expect(onAnswer).toHaveBeenCalledWith('call-3');

    unregisterModuleScope();
    expect(mockCallKeep.removeEventListener).toHaveBeenCalledWith('answerCall');
    expect(mockCallKeep.removeEventListener).toHaveBeenCalledWith('endCall');
  });

  test('a stale detach does not clobber a handler attached after it', () => {
    mod.registerCallActionListeners();
    const firstOnAnswer = jest.fn();
    const detachFirst = mod.setCallActionHandlers({ onAnswer: firstOnAnswer, onEnd: jest.fn() });

    const secondOnAnswer = jest.fn();
    mod.setCallActionHandlers({ onAnswer: secondOnAnswer, onEnd: jest.fn() });

    // e.g. useCallFlow's effect cleanup running after a fast remount already
    // replaced by the new mount's own setCallActionHandlers call.
    detachFirst();

    const answerCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'answerCall')[1];
    answerCb({ callUUID: 'call-4' });

    expect(secondOnAnswer).toHaveBeenCalledWith('call-4');
    expect(firstOnAnswer).not.toHaveBeenCalled();
  });

  test('endCall with no call flow attached forgets the call locally so it can ring again', async () => {
    mod.registerCallActionListeners();
    await mod.displayIncomingCall({ callId: 'end-headless', callerId: 'alice' });

    const endCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'endCall')[1];
    endCb({ callUUID: 'end-headless' });

    await mod.displayIncomingCall({ callId: 'end-headless', callerId: 'alice' });
    expect(mockCallKeep.displayIncomingCall).toHaveBeenCalledTimes(2);
  });

  test('endCall for an attached call flow is routed to onEnd', () => {
    mod.registerCallActionListeners();
    const onEnd = jest.fn();
    mod.setCallActionHandlers({ onAnswer: jest.fn(), onEnd });

    const endCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'endCall')[1];
    endCb({ callUUID: 'call-5' });

    expect(onEnd).toHaveBeenCalledWith('call-5');
  });

  test('registerShowIncomingCallUiListener subscribes at module scope', () => {
    const unregister = mod.registerShowIncomingCallUiListener();
    expect(mockCallKeep.addEventListener).toHaveBeenCalledWith(
      'showIncomingCallUi',
      expect.any(Function),
    );
    expect(typeof unregister).toBe('function');
  });

  test('showIncomingCallUi shows the branded notification with the caller identity', async () => {
    mod.registerShowIncomingCallUiListener();
    const handler = mockCallKeep.addEventListener.mock.calls.find(
      c => c[0] === 'showIncomingCallUi',
    )[1];

    await handler({ callUUID: 'call-6', handle: 'alice', name: 'Alice' });

    expect(mockShowIncomingCallNotification).toHaveBeenCalledWith({
      callId: 'call-6',
      callerId: 'Alice',
    });
    expect(mockStartIncomingRingtone).not.toHaveBeenCalled();
  });

  test('showIncomingCallUi falls back to an audible ring when the branded notification cannot be shown', async () => {
    mockShowIncomingCallNotification.mockResolvedValueOnce(false);
    mod.registerShowIncomingCallUiListener();
    const handler = mockCallKeep.addEventListener.mock.calls.find(
      c => c[0] === 'showIncomingCallUi',
    )[1];

    await handler({ callUUID: 'call-7', name: 'Bob' });

    expect(mockStartIncomingRingtone).toHaveBeenCalledTimes(1);
  });

  test('showIncomingCallUi falls back to an audible ring when showing throws', async () => {
    mockShowIncomingCallNotification.mockRejectedValueOnce(new Error('boom'));
    mod.registerShowIncomingCallUiListener();
    const handler = mockCallKeep.addEventListener.mock.calls.find(
      c => c[0] === 'showIncomingCallUi',
    )[1];

    await handler({ callUUID: 'call-8', name: 'Carol' });

    expect(mockStartIncomingRingtone).toHaveBeenCalledTimes(1);
  });

  test('answerCall dismisses the branded notification and stops the fallback ringtone', () => {
    mod.registerCallActionListeners();
    const answerCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'answerCall')[1];

    answerCb({ callUUID: 'call-9' });

    expect(mockDismissIncomingCallNotification).toHaveBeenCalledWith('call-9');
    expect(mockStopIncomingRingtone).toHaveBeenCalledTimes(1);
  });

  test('endCall dismisses the branded notification and stops the fallback ringtone', () => {
    mod.registerCallActionListeners();
    const endCb = mockCallKeep.addEventListener.mock.calls.find(c => c[0] === 'endCall')[1];

    endCb({ callUUID: 'call-10' });

    expect(mockDismissIncomingCallNotification).toHaveBeenCalledWith('call-10');
    expect(mockStopIncomingRingtone).toHaveBeenCalledTimes(1);
  });
});

// ─── The single pending-answer queue ──────────────────────────────────────────
//
// An answer tapped before the call flow is listening used to be split across
// two queues (one here, one in useCallFlow), and could be lost in the hand-off.
// There is now exactly one, with explicit enqueue / drain / drop logging.

describe('callKeep pending-answer queue', () => {
  let mod;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock('react-native-callkeep', () => ({ default: mockCallKeep }));
    mod = require('../src/callKeep');
    mod._resetCallKeepCache();
    mod.clearPendingAnswer();
  });

  afterEach(() => {
    jest.dontMock('react-native-callkeep');
  });

  test('records an answer and drains it exactly once', () => {
    expect(mod.recordPendingAnswer('call-q1', 'native_no_handler')).toBe(true);
    expect(mod.peekPendingAnswer()).toBe('call-q1');
    expect(mod.consumePendingAnswer('call-q1')).toBe('call-q1');
    expect(mod.peekPendingAnswer()).toBeNull();
    expect(mod.consumePendingAnswer('call-q1')).toBeNull();
  });

  test('does not drain an answer queued for a different call', () => {
    mod.recordPendingAnswer('call-q2', 'native_no_handler');
    expect(mod.consumePendingAnswer('other-call')).toBeNull();
    expect(mod.peekPendingAnswer()).toBe('call-q2');
  });

  test('clearPendingAnswer drops only the matching call', () => {
    mod.recordPendingAnswer('call-q3', 'native_no_handler');
    expect(mod.clearPendingAnswer('other-call', 'ended')).toBe(false);
    expect(mod.peekPendingAnswer()).toBe('call-q3');
    expect(mod.clearPendingAnswer('call-q3', 'ended')).toBe(true);
    expect(mod.peekPendingAnswer()).toBeNull();
  });

  test('ignores an empty callId', () => {
    expect(mod.recordPendingAnswer(undefined, 'native_no_handler')).toBe(false);
    expect(mod.peekPendingAnswer()).toBeNull();
  });

  test('attaching handlers replays a queued answer instead of dropping it', () => {
    mod.recordPendingAnswer('call-q4', 'native_no_handler');
    const onAnswer = jest.fn();
    mod.setCallActionHandlers({ onAnswer, onEnd: jest.fn() });

    expect(onAnswer).toHaveBeenCalledWith('call-q4');
    // Drained: a second attach must not replay the same answer again.
    const onAnswerAgain = jest.fn();
    mod.setCallActionHandlers({ onAnswer: onAnswerAgain, onEnd: jest.fn() });
    expect(onAnswerAgain).not.toHaveBeenCalled();
  });
});
