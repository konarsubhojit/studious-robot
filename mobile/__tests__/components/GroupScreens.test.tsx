import React from 'react';
import renderer, { act } from 'react-test-renderer';
import GroupDirectorySheet from '../../src/components/GroupDirectorySheet';
import GroupConversationScreen from '../../src/components/GroupConversationScreen';
import ChatListScreen from '../../src/components/ChatListScreen';
import SearchScreen, { SEARCH_DEBOUNCE_MS } from '../../src/components/SearchScreen';
import { createMockGroup } from '../../src/chat/groupMockAdapter';
import { startMockGroupCall, transitionMockGroupCall } from '../../src/chat/groupCallAdapter';
import type { ChatMessage } from '../../src/messaging/types';

const mounted: renderer.ReactTestRenderer[] = [];
const find = (tree: renderer.ReactTestRenderer, id: string) =>
  tree.root.findAll(node => node.props.testID === id)[0];
const text = (tree: renderer.ReactTestRenderer) => tree.root
  .findAll(node => typeof node.type === 'string')
  .flatMap(node => node.children.filter(child => typeof child === 'string'))
  .join('');
async function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => { tree = renderer.create(element); });
  mounted.push(tree);
  return tree;
}
async function directoryTick() {
  await act(async () => { jest.advanceTimersByTime(250); await Promise.resolve(); });
}
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  act(() => { mounted.splice(0).forEach(tree => tree.unmount()); });
  jest.useRealTimers();
});

test('directory creation multi-select excludes self, retains selections across searches and opens the created group', async () => {
  const search = jest.fn(async (query: string) => query ? [{ userId: 'carol' }] : [
    { userId: 'alice' }, { userId: 'bob' }, { userId: 'bob' },
  ]);
  const create = jest.fn(async () => 'mock-group-created');
  const open = jest.fn();
  const openDirect = jest.fn();
  const tree = await render(<ChatListScreen currentUserId="alice" onSearchUsers={search}
    onCreateGroup={create} onOpenConversation={openDirect} onOpenGroup={open} />);
  act(() => find(tree, 'chat-list-new-group').props.onPress());
  await directoryTick();
  expect(search).toHaveBeenCalledWith('');
  expect(tree.root.findAll(node => node.props.testID === 'group-select-alice')).toHaveLength(0);
  act(() => {
    find(tree, 'group-name').props.onChangeText('Project');
    find(tree, 'group-select-bob').props.onPress();
    find(tree, 'group-directory-query').props.onChangeText('car');
  });
  await directoryTick();
  expect(text(tree)).toContain('bob');
  expect(find(tree, 'group-directory-submit').props.disabled).toBe(true);
  act(() => find(tree, 'group-select-carol').props.onPress());
  await act(async () => { find(tree, 'group-directory-submit').props.onPress(); });
  expect(create).toHaveBeenCalledWith('Project', ['bob', 'carol']);
  expect(open).toHaveBeenCalledWith('mock-group-created');
  expect(openDirect).not.toHaveBeenCalled();
});

test('directory ignores stale responses and shows errors without losing selected members', async () => {
  let resolveOld!: (users: { userId: string }[]) => void;
  const search = jest.fn()
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce([{ userId: 'carol' }])
    .mockRejectedValueOnce(new Error('offline'));
  const props = { visible: true, currentUserId: 'alice', onClose: jest.fn(), onSearchUsers: search,
    onSubmit: jest.fn(async () => { throw new Error('disk full'); }) };
  const tree = await render(<GroupDirectorySheet {...props} />);
  await directoryTick();
  act(() => find(tree, 'group-directory-query').props.onChangeText('car'));
  await directoryTick();
  await act(async () => { resolveOld([{ userId: 'bob' }]); });
  expect(tree.root.findAll(node => node.props.testID === 'group-select-bob')).toHaveLength(0);
  act(() => {
    find(tree, 'group-select-carol').props.onPress();
    find(tree, 'group-directory-query').props.onChangeText('bad');
  });
  await directoryTick();
  expect(text(tree)).toContain('Directory unavailable');
  expect(text(tree)).toContain('carol');
});

test('add picker excludes existing members and submit errors remain actionable', async () => {
  const submit = jest.fn(async () => { throw new Error('disk full'); });
  const tree = await render(<GroupDirectorySheet visible adding currentUserId="alice"
    excludedIds={['bob']} onClose={jest.fn()} onSearchUsers={async () => [{ userId: 'bob' }, { userId: 'dave' }]}
    onSubmit={submit} />);
  await directoryTick();
  expect(tree.root.findAll(node => node.props.testID === 'group-select-bob')).toHaveLength(0);
  act(() => find(tree, 'group-select-dave').props.onPress());
  await act(async () => { find(tree, 'group-directory-submit').props.onPress(); });
  expect(submit).toHaveBeenCalledWith('', ['dave']);
  expect(text(tree)).toContain('disk full');
  expect(find(tree, 'group-directory-submit').props.disabled).toBe(false);
});

function groupProps(currentUserId = 'alice') {
  const conversation = createMockGroup('alice', 'Team', ['bob', 'carol'], 'mock-group-1');
  return {
    conversation,
    callSnapshot: startMockGroupCall(conversation, 'alice', 'mock-call-1', 'audio', '2026-10-03T06:00:00Z'),
    callActions: { start: jest.fn(async () => {}), transition: jest.fn(async () => {}), simulate: jest.fn(async () => {}) },
    messages: [] as ChatMessage[], currentUserId, typing: { bob: true, carol: true },
    actions: { mode: 'mock' as const, create: jest.fn(), members: jest.fn(async () => {}), rename: jest.fn(async () => {}),
      leave: jest.fn(async () => {}), previewActivity: jest.fn() },
    onSearchUsers: jest.fn(async () => []), onSend: jest.fn(async () => 'm1'),
    onRetry: jest.fn(async () => {}), onTyping: jest.fn(), onRead: jest.fn(async () => {}),
    onBack: jest.fn(), draft: 'hello group', onDraft: jest.fn(), offline: true,
  };
}

test('group timeline attributes bubbles, summarizes read members and clears a durably accepted draft', async () => {
  const props = groupProps();
  props.conversation.readByMember = { bob: '2026-10-03T02:00:00Z', carol: '2026-10-03T02:00:00Z' };
  props.messages = [
    { messageId: 'm2', senderId: 'alice', recipientId: 'mock-group-1', body: 'my message', createdAt: '2026-10-03T01:00:00Z' },
    { messageId: 'm1', senderId: 'bob', recipientId: 'mock-group-1', body: 'from bob' },
  ];
  const tree = await render(<GroupConversationScreen {...props} />);
  expect(text(tree)).toContain('from bob');
  expect(text(tree)).toContain('You');
  expect(text(tree)).toContain('Read by bob, carol');
  expect(text(tree)).toContain('bob, carol');
  expect(text(tree)).toContain('durably queued');
  expect(props.onRead).toHaveBeenCalledTimes(1);
  act(() => find(tree, 'group-composer').props.onChangeText('new text'));
  expect(props.onDraft).toHaveBeenCalledWith('new text');
  expect(props.onTyping).toHaveBeenCalledWith(true);
  await act(async () => { find(tree, 'group-send').props.onPress(); });
  expect(props.onSend).toHaveBeenCalledWith('hello group');
  expect(props.onDraft).toHaveBeenCalledWith('');
});

test('member management offers admin add/remove/rename and routes failures without closing the sheet', async () => {
  const props = groupProps();
  props.actions.members.mockRejectedValueOnce(new Error('save failed'));
  const tree = await render(<GroupConversationScreen {...props} />);
  act(() => find(tree, 'group-open-members').props.onPress());
  await act(async () => { find(tree, 'group-remove-bob').props.onPress(); });
  expect(props.actions.members).toHaveBeenCalledWith('mock-group-1', { type: 'remove', userId: 'bob' });
  expect(text(tree)).toContain('save failed');
  expect(find(tree, 'group-members-sheet')).toBeDefined();
  act(() => find(tree, 'group-add-members').props.onPress());
  expect(find(tree, 'group-directory-sheet')).toBeDefined();
});

test('non-admin members cannot mutate membership and leave navigates back', async () => {
  const props = groupProps('bob');
  const tree = await render(<GroupConversationScreen {...props} />);
  act(() => find(tree, 'group-open-members').props.onPress());
  expect(tree.root.findAll(node => node.props.testID === 'group-add-members')).toHaveLength(0);
  expect(tree.root.findAll(node => node.props.testID === 'group-remove-carol')).toHaveLength(0);
  expect(tree.root.findAll(node => node.props.testID === 'group-rename')).toHaveLength(0);
  await act(async () => { find(tree, 'group-leave').props.onPress(); });
  expect(props.actions.leave).toHaveBeenCalledWith('mock-group-1');
  expect(props.onBack).toHaveBeenCalledTimes(1);
});

test('participant grid is explicitly media-free and shows individual mute/leave states', async () => {
  const props = groupProps();
  const tree = await render(<GroupConversationScreen {...props} />);
  act(() => find(tree, 'group-open-call').props.onPress());
  expect(text(tree)).toContain('no actual media');
  expect(find(tree, 'group-participant-carol')).toBeDefined();
  act(() => find(tree, 'group-call-mute-bob').props.onPress());
  expect(text(tree)).toContain('Muted (simulated)');
  await act(async () => { find(tree, 'group-call-leave-alice').props.onPress(); });
  expect(props.callActions.transition).toHaveBeenCalledWith('mock-group-1', 'leave');
  props.callSnapshot = transitionMockGroupCall(props.callSnapshot, 'alice', 'leave', '2026-10-03T06:02:00Z');
  await act(async () => { tree.update(<GroupConversationScreen {...props} />); });
  expect(text(tree)).toContain('Left preview');
  expect(find(tree, 'group-call-mute-alice').props.disabled).toBe(true);
  expect(props.actions.leave).not.toHaveBeenCalled();
  expect(props.onSend).not.toHaveBeenCalled();
});

test('remote preview uses participant snapshots and only self lifecycle controls with local mute', async () => {
  const props = groupProps('bob');
  props.conversation.localMock = false;
  const tree = await render(<GroupConversationScreen {...props} />);
  act(() => find(tree, 'group-open-call').props.onPress());
  expect(text(tree)).toContain('notifies other participants');
  expect(tree.root.findAll(node => node.props.testID === 'group-call-mute-alice')).toHaveLength(0);
  await act(async () => { find(tree, 'group-call-accept-bob').props.onPress(); });
  expect(props.callActions.transition).toHaveBeenCalledWith('mock-group-1', 'accept');
  expect(props.callActions.simulate).not.toHaveBeenCalled();
  act(() => find(tree, 'group-call-mute-bob').props.onPress());
  expect(text(tree)).toContain('Muted (simulated)');
  expect(props.callActions.transition).toHaveBeenCalledTimes(1);
});

test('call preview explicitly starts lifecycle signaling and displays request failures inside the sheet', async () => {
  const props = groupProps();
  props.conversation.localMock = false;
  props.callActions.start.mockRejectedValueOnce(new Error('Connect before changing a group call'));
  const tree = await render(<GroupConversationScreen {...props} callSnapshot={undefined} />);
  act(() => find(tree, 'group-open-call').props.onPress());
  await act(async () => { find(tree, 'group-call-start-video').props.onPress(); });
  expect(props.callActions.start).toHaveBeenCalledWith('mock-group-1', 'video');
  expect(text(tree)).toContain('Connect before changing a group call');
  expect(find(tree, 'group-call-start-video').props.disabled).toBe(false);
  expect(props.actions.leave).not.toHaveBeenCalled();
});

test('removed members have disabled composer, sends, and call preview', async () => {
  const props = groupProps();
  props.conversation.left = true;
  const tree = await render(<GroupConversationScreen {...props} />);
  expect(find(tree, 'group-composer').props.editable).toBe(false);
  expect(find(tree, 'group-send').props.disabled).toBe(true);
  expect(find(tree, 'group-open-call').props.disabled).toBe(true);
  expect(props.onRead).not.toHaveBeenCalled();
});

test('unified search matches group names and opens the conversation key without treating it as a person', async () => {
  const open = jest.fn();
  const profile = jest.fn();
  const tree = await render(<SearchScreen conversations={[
    createMockGroup('alice', 'Project team', ['bob', 'carol'], 'mock-group-1'),
  ]} onOpenConversation={open} onOpenProfile={profile} />);
  act(() => find(tree, 'search-input').props.onChangeText('project'));
  await act(async () => { jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
  act(() => find(tree, 'search-conversation-row').props.onPress());
  expect(open).toHaveBeenCalledWith('mock-group-1');
  expect(profile).not.toHaveBeenCalled();
});
