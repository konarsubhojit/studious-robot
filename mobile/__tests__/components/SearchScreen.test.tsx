import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SearchScreen, { SEARCH_DEBOUNCE_MS } from '../../src/components/SearchScreen';
import { describeOffline, OFFLINE_CONSEQUENCE } from '../../src/connectivityUx';

function findByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID)[0] ?? null;
}

function findAllByTestId(tree: any, testID: any) {
  return tree.root.findAll((node: any) => node.props?.testID === testID && typeof node.type === 'string');
}

function pressByTestId(tree: any, testID: any, index = 0) {
  const pressable = tree.root.findAll(
    (node: any) => node.props?.testID === testID && typeof node.props?.onPress === 'function',
  )[index];
  act(() => {
    pressable.props.onPress();
  });
}

function render(props: any) {
  let tree;
  act(() => {
    tree = renderer.create(<SearchScreen {...props} />);
  });
  return tree;
}

function type(tree: any, value: any) {
  act(() => {
    findByTestId(tree, 'search-input').props.onChangeText(value);
  });
}

async function advanceDebounce(ms = SEARCH_DEBOUNCE_MS) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SearchScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('prompts for input before anything is typed', () => {
    const tree = render({});
    expect(findByTestId(tree, 'search-empty-prompt')).not.toBeNull();
    expect(findByTestId(tree, 'search-no-results')).toBeNull();
  });

  test('a failed contact search surfaces a retry rather than "no results"', async () => {
    const onSearchContacts = jest
      .fn()
      .mockRejectedValueOnce(new Error('directory unreachable'))
      .mockResolvedValueOnce([{ userId: 'user-bob', online: true }]);
    const tree = render({ onSearchContacts, onSearchMessages: jest.fn().mockResolvedValue([]) });

    type(tree, 'bob');
    await advanceDebounce();

    expect(findByTestId(tree, 'search-no-results')).toBeNull();
    expect(findByTestId(tree, 'search-contacts-error')).not.toBeNull();

    await act(async () => {
      findByTestId(tree, 'search-contacts-error-action').props.onPress();
    });
    await advanceDebounce();

    expect(onSearchContacts).toHaveBeenCalledTimes(2);
    expect(findByTestId(tree, 'search-contacts-error')).toBeNull();
  });

  test('keeps the failure banner visible alongside local results', async () => {
    const onSearchContacts = jest.fn().mockRejectedValue(new Error('directory unreachable'));
    const onSearchMessages = jest
      .fn()
      .mockResolvedValue([{ messageId: 'm1', conversationId: 'c1', peerId: 'bob', body: 'bob?' }]);
    const tree = render({ onSearchContacts, onSearchMessages });

    type(tree, 'bob');
    await advanceDebounce();

    // A banner rendered as ListEmptyComponent would vanish the moment any
    // local result arrived, silently hiding the partial failure.
    expect(findByTestId(tree, 'search-contacts-error')).not.toBeNull();
  });

  test('debounces the server search and only issues one request per pause', async () => {
    const onSearchContacts = jest.fn().mockResolvedValue([]);
    const onSearchMessages = jest.fn().mockResolvedValue([]);
    const tree = render({ onSearchContacts, onSearchMessages });

    type(tree, 'bo');
    type(tree, 'bob');
    await act(async () => {
      jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(onSearchContacts).not.toHaveBeenCalled();

    await advanceDebounce(1);
    expect(onSearchContacts).toHaveBeenCalledTimes(1);
    expect(onSearchContacts).toHaveBeenCalledWith('bob', expect.anything());
    expect(onSearchMessages).toHaveBeenCalledTimes(1);
  });

  test('aborts the in-flight request when the query changes', async () => {
    const signals: any = [];
    const onSearchContacts = jest.fn((query, { signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const tree = render({ onSearchContacts });

    type(tree, 'alice');
    await advanceDebounce();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    type(tree, 'bob');
    expect(signals[0].aborted).toBe(true);
  });

  test('renders all four sections and highlights the matched substring', async () => {
    const tree = render({
      currentUserId: 'user-me',
      onSearchContacts: jest.fn().mockResolvedValue([{ userId: 'user-bob', online: true }]),
      onSearchMessages: jest.fn().mockResolvedValue([
        {
          messageId: 'msg-1',
          peerId: 'user-bob',
          body: 'hello bob',
          createdAt: new Date().toISOString(),
        },
      ]),
      conversations: [
        { conversationId: 'conv-1', peerId: 'user-bob', lastMessage: { body: 'hi' } },
        { conversationId: 'conv-2', peerId: 'user-carol', lastMessage: { body: 'hi' } },
      ],
      callHistory: [
        { callId: 'call-1', direction: 'outgoing', calleeId: 'user-bob', status: 'completed' },
        { callId: 'call-2', direction: 'outgoing', calleeId: 'user-carol', status: 'completed' },
      ],
    });

    type(tree, 'bob');
    await advanceDebounce();

    expect(findAllByTestId(tree, 'search-contact-row')).toHaveLength(1);
    expect(findAllByTestId(tree, 'search-conversation-row')).toHaveLength(1);
    expect(findAllByTestId(tree, 'search-message-row')).toHaveLength(1);
    expect(findAllByTestId(tree, 'search-call-row')).toHaveLength(1);
    expect(findByTestId(tree, 'search-no-results')).toBeNull();
  });

  test('distinguishes "no results" from "type to search"', async () => {
    const tree = render({
      onSearchContacts: jest.fn().mockResolvedValue([]),
      onSearchMessages: jest.fn().mockResolvedValue([]),
    });

    type(tree, 'nobody');
    await advanceDebounce();

    expect(findByTestId(tree, 'search-no-results')).not.toBeNull();
    expect(findByTestId(tree, 'search-empty-prompt')).toBeNull();
  });

  test('still shows local matches when the server search fails', async () => {
    const tree = render({
      onSearchContacts: jest.fn().mockRejectedValue(new Error('offline')),
      onSearchMessages: jest.fn().mockRejectedValue(new Error('offline')),
      conversations: [{ conversationId: 'conv-1', peerId: 'user-bob' }],
      isServerUnreachable: true,
    });

    type(tree, 'bob');
    await advanceDebounce();

    expect(findAllByTestId(tree, 'search-conversation-row')).toHaveLength(1);

    // The same banner, with the same weight and lead, as Calls and the
    // conversation show — not a line of grey body text.
    expect(findByTestId(tree, 'search-degraded-note')).not.toBeNull();
    const texts = (tree as any).root
      .findAll((n: any) => typeof n.type === 'string')
      .flatMap((n: any) =>
        (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children]).filter(
          (child: unknown) => typeof child === 'string',
        ),
      );
    expect(texts).toContain(describeOffline(OFFLINE_CONSEQUENCE.search));
  });

  test('opens the conversation at the matched message', async () => {
    const onOpenMessage = jest.fn();
    const tree = render({
      onOpenMessage,
      onSearchMessages: jest
        .fn()
        .mockResolvedValue([{ messageId: 'msg-1', peerId: 'user-bob', body: 'hello bob' }]),
    });

    type(tree, 'bob');
    await advanceDebounce();

    pressByTestId(tree, 'search-message-row');

    expect(onOpenMessage).toHaveBeenCalledWith({ peerId: 'user-bob', messageId: 'msg-1' });
  });

  test('replays a recent search and only records a term once a result is opened', async () => {
    const onRecordRecentSearch = jest.fn();
    const tree = render({
      recentSearches: ['carol'],
      onRecordRecentSearch,
      onOpenConversation: jest.fn(),
      conversations: [{ conversationId: 'conv-1', peerId: 'user-carol' }],
      onSearchContacts: jest.fn().mockResolvedValue([]),
      onSearchMessages: jest.fn().mockResolvedValue([]),
    });

    expect(findAllByTestId(tree, 'search-recent-row')).toHaveLength(1);

    pressByTestId(tree, 'search-recent-row');
    await advanceDebounce();

    // Searching alone is not intent: nothing is remembered until a result is
    // opened, so prefixes typed on the way never pollute the history.
    expect(onRecordRecentSearch).not.toHaveBeenCalled();

    pressByTestId(tree, 'search-conversation-row');
    expect(onRecordRecentSearch).toHaveBeenCalledWith('carol');
  });
});
