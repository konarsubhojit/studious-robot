// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useChatDeepLink, { resolveChatPeerId } from '../../src/hooks/useChatDeepLink';
import { addChatLinkListener, getInitialChatLink } from '../../src/pushNotifications';

jest.mock('../../src/appLogger', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock('../../src/pushNotifications', () => ({
  addChatLinkListener: jest.fn(() => jest.fn()),
  getInitialChatLink: jest.fn(async () => null),
}));

function TestHook(/** @type {any} */ { params }: any) {
  useChatDeepLink(params);
  return null;
}

async function setup(overrides = {}) {
  const params = {
    userId: 'bob',
    conversations: [],
    onOpenConversation: jest.fn(),
    ...overrides,
  };
  /** @type {any} */
  let tree: any;
  await act(async () => {
    tree = renderer.create(<TestHook params={params} />);
    await Promise.resolve();
  });
  return { params, tree };
}

beforeEach(() => {
  jest.clearAllMocks();
  /** @type {jest.Mock} */ (getInitialChatLink).mockResolvedValue(null);
  /** @type {jest.Mock} */ (addChatLinkListener).mockReturnValue(jest.fn());
});

describe('resolveChatPeerId', () => {
  test('prefers the loaded conversation list', () => {
    expect(
      resolveChatPeerId({
        conversationId: 'conv-1',
        userId: 'bob',
        conversations: [{ conversationId: 'conv-1', peerId: 'alice' }],
      }),
    ).toBe('alice');
  });

  test('derives the peer from the server conversation-id format', () => {
    expect(resolveChatPeerId({ conversationId: 'alice:bob', userId: 'bob' })).toBe('alice');
    expect(resolveChatPeerId({ conversationId: 'bob:carol', userId: 'bob' })).toBe('carol');
  });

  test('returns null when the peer cannot be determined', () => {
    expect(resolveChatPeerId({ conversationId: 'alice:bob', userId: '' })).toBeNull();
    expect(resolveChatPeerId({ conversationId: '', userId: 'bob' })).toBeNull();
    expect(resolveChatPeerId({ conversationId: 'carol:dave', userId: 'bob' })).toBeNull();
  });
});

describe('useChatDeepLink', () => {
  test('opens the conversation the app was cold-started from', async () => {
    /** @type {jest.Mock} */ (getInitialChatLink).mockResolvedValue({ conversationId: 'alice:bob' });
    const { params } = await setup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(params.onOpenConversation).toHaveBeenCalledWith('alice');
  });

  test('opens the conversation for a link received while running', async () => {
    /** @type {any} */
    let emit: any;
    /** @type {jest.Mock} */ (addChatLinkListener).mockImplementation(/** @type {any} */ callback => {
      emit = callback;
      return jest.fn();
    });
    const { params } = await setup();

    await act(async () => {
      emit({ conversationId: 'alice:bob' });
      await Promise.resolve();
    });
    expect(params.onOpenConversation).toHaveBeenCalledWith('alice');
  });

  test('holds the link until the peer can be resolved', async () => {
    /** @type {jest.Mock} */ (getInitialChatLink).mockResolvedValue({ conversationId: 'conv-1' });
    const { params, tree } = await setup({ userId: '', conversations: [] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(params.onOpenConversation).not.toHaveBeenCalled();

    await act(async () => {
      tree.update(
        <TestHook
          params={{ ...params, conversations: [{ conversationId: 'conv-1', peerId: 'alice' }] }}
        />,
      );
      await Promise.resolve();
    });
    expect(params.onOpenConversation).toHaveBeenCalledWith('alice');
  });

  test('routes each link once', async () => {
    /** @type {jest.Mock} */ (getInitialChatLink).mockResolvedValue({ conversationId: 'alice:bob' });
    const { params, tree } = await setup();
    await act(async () => {
      await Promise.resolve();
      tree.update(<TestHook params={params} />);
      await Promise.resolve();
    });
    expect(params.onOpenConversation).toHaveBeenCalledTimes(1);
  });

  test('unsubscribes the listener on unmount', async () => {
    const unsubscribe = jest.fn();
    /** @type {jest.Mock} */ (addChatLinkListener).mockReturnValue(unsubscribe);
    const { tree } = await setup();
    await act(async () => {
      tree.unmount();
    });
    expect(unsubscribe).toHaveBeenCalled();
  });
});
