import { NativeModules, Platform } from 'react-native';
import {
  dismissMessageNotification,
  getActiveConversation,
  hasSeenMessage,
  isConversationOnScreen,
  isMessageNotificationAvailable,
  markMessageSeen,
  resetMessageNotificationState,
  setActiveConversation,
  showMessageNotification,
} from '../src/messageNotification';

jest.mock('../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {},
}));

const MESSAGE = {
  messageId: 'message-1',
  conversationId: 'alice:bob',
  senderId: 'alice',
  title: 'alice',
  body: 'hey there',
  deepLink: 'wetalk://chat/alice:bob',
};

beforeEach(() => {
  resetMessageNotificationState();
  Platform.OS = 'android';
  NativeModules.MessageNotification = {
    show: jest.fn(async () => ({ shown: true, channelImportance: 3, messageCount: 1 })),
    dismiss: jest.fn(),
  };
});

afterEach(() => {
  delete NativeModules.MessageNotification;
  jest.clearAllMocks();
});

describe('native module availability', () => {
  test('reports availability only on Android with the module linked', () => {
    expect(isMessageNotificationAvailable()).toBe(true);

    Platform.OS = 'ios';
    expect(isMessageNotificationAvailable()).toBe(false);

    Platform.OS = 'android';
    delete NativeModules.MessageNotification;
    expect(isMessageNotificationAvailable()).toBe(false);
  });
});

describe('showMessageNotification', () => {
  test('posts the notification through the native module', async () => {
    await expect(showMessageNotification(MESSAGE)).resolves.toEqual({ shown: true });
    expect(NativeModules.MessageNotification.show).toHaveBeenCalledWith(
      'alice:bob',
      'alice',
      'hey there',
      'wetalk://chat/alice:bob',
    );
  });

  test('falls back to sender and a default deep link when fields are missing', async () => {
    await showMessageNotification({
      messageId: 'message-2',
      conversationId: 'alice:bob',
      senderId: 'alice',
    });
    expect(NativeModules.MessageNotification.show).toHaveBeenCalledWith(
      'alice:bob',
      'alice',
      'Sent you a message',
      'wetalk://chat/alice:bob',
    );
  });

  test('marks the message seen so a duplicate push does not notify twice', async () => {
    expect(hasSeenMessage('message-1')).toBe(false);
    await showMessageNotification(MESSAGE);
    expect(hasSeenMessage('message-1')).toBe(true);
  });

  test('reports why nothing was shown instead of throwing', async () => {
    await expect(showMessageNotification({ ...MESSAGE, conversationId: '' })).resolves.toEqual({
      shown: false,
      reason: 'missing_conversation_id',
    });

    delete NativeModules.MessageNotification;
    await expect(showMessageNotification(MESSAGE)).resolves.toEqual({
      shown: false,
      reason: 'module_unavailable',
    });
  });

  test('reports a native failure as not shown', async () => {
    NativeModules.MessageNotification.show.mockRejectedValue(new Error('notify failed'));
    await expect(showMessageNotification(MESSAGE)).resolves.toEqual({
      shown: false,
      reason: 'notification_threw',
    });
    expect(hasSeenMessage('message-1')).toBe(false);
  });
});

describe('dismissMessageNotification', () => {
  test('dismisses by conversation id', () => {
    expect(dismissMessageNotification('alice:bob')).toBe(true);
    expect(NativeModules.MessageNotification.dismiss).toHaveBeenCalledWith('alice:bob');
  });

  test('is a no-op without a conversation id or native module', () => {
    expect(dismissMessageNotification('')).toBe(false);
    delete NativeModules.MessageNotification;
    expect(dismissMessageNotification('alice:bob')).toBe(false);
  });
});

describe('active conversation tracking', () => {
  test('matches the open conversation by peer or conversation id', () => {
    setActiveConversation({ peerId: 'alice', conversationId: 'alice:bob' });
    expect(getActiveConversation()).toEqual({ peerId: 'alice', conversationId: 'alice:bob' });
    expect(isConversationOnScreen({ senderId: 'alice' })).toBe(true);
    expect(isConversationOnScreen({ conversationId: 'alice:bob' })).toBe(true);
    expect(isConversationOnScreen({ senderId: 'carol', conversationId: 'bob:carol' })).toBe(false);
  });

  test('matches nothing once the conversation is closed', () => {
    setActiveConversation({ peerId: 'alice', conversationId: 'alice:bob' });
    setActiveConversation(null);
    expect(getActiveConversation()).toBeNull();
    expect(isConversationOnScreen({ senderId: 'alice' })).toBe(false);
  });
});

describe('seen-message registry', () => {
  test('remembers message ids and ignores blanks', () => {
    markMessageSeen('message-9');
    expect(hasSeenMessage('message-9')).toBe(true);
    markMessageSeen('   ');
    expect(hasSeenMessage('')).toBe(false);
  });

  test('is bounded so it cannot grow without limit', () => {
    for (let index = 0; index < 250; index += 1) {
      markMessageSeen(`message-${index}`);
    }
    expect(hasSeenMessage('message-249')).toBe(true);
    expect(hasSeenMessage('message-0')).toBe(false);
  });
});
