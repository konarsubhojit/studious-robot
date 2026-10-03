import React, { StrictMode } from 'react';
import renderer, { act } from 'react-test-renderer';
import { AppState, Text } from 'react-native';
import { cacheAvatarImage } from '../../src/avatarImageCache';
import { ProfileDataProvider, usePeerProfile } from '../../src/profile/ProfileContext';
import Avatar from '../../src/components/primitives/Avatar';
import RingingAvatar from '../../src/components/RingingAvatar';
import ChatListScreen from '../../src/components/ChatListScreen';
import ChatConversationScreen from '../../src/components/ChatConversationScreen';
import CallsScreen from '../../src/components/CallsScreen';
import IncomingCallScreen from '../../src/components/IncomingCallScreen';
import OutgoingCallScreen from '../../src/components/OutgoingCallScreen';
import PeerProfileScreen from '../../src/components/PeerProfileScreen';
import SettingsScreen from '../../src/components/SettingsScreen';
import SearchScreen, { SEARCH_DEBOUNCE_MS } from '../../src/components/SearchScreen';
import PeoplePickerSheet from '../../src/components/PeoplePickerSheet';
import { ListItem } from '../../src/components/primitives';
import { installRenderCleanup } from '../../testUtils/renderCleanup';
import type { ProfileTransport } from '../../src/profile/profileStore';
import type { ReactNode } from 'react';
import type { AppStateStatus } from 'react-native';

jest.mock('react-native-nitro-sound', () => ({ default: {} }));
jest.mock('../../src/avatarImageCache', () => ({ cacheAvatarImage: jest.fn(async () => null) }));
installRenderCleanup();
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const peerId = 'raw-peer-id';
const displayName = '  Ada Lovelace  ';
const name = 'Ada Lovelace';
const response = (value: unknown) => ({ ok: true, json: async () => value } as Response);
function makeTransport(overrides: Partial<ProfileTransport> = {}): ProfileTransport {
  return {
    signalingUrl: 'https://signal.example', userId: 'self-id',
    searchUsers: jest.fn(async () => [{ userId: peerId, displayName, avatarKey: 'key' }]),
    authedFetch: jest.fn(async build => {
      const request = build('session');
      return response(request.url.endsWith('/profile')
        ? { displayName: 'Self Name' }
        : {
          userId: decodeURIComponent(request.url.split('userId=')[1] ?? ''),
          avatarKey: 'key',
          downloadUrl: 'https://media.example/avatar',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
    }),
    ...overrides,
  };
}
async function renderProfile(children: ReactNode, transport = makeTransport(), blockedUsers: string[] = []) {
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(
      <ProfileDataProvider transport={transport} blockedUsers={blockedUsers}>{children}</ProfileDataProvider>,
    );
  });
  return tree;
}
const node = (tree: ReturnType<typeof renderer.create>, testID: string) =>
  tree.root.findAll(n => n.props.testID === testID)[0];
const button = (tree: ReturnType<typeof renderer.create>, testID: string) =>
  tree.root.findAll(n => n.props.testID === testID && typeof n.props.onPress === 'function')[0];
const texts = (tree: ReturnType<typeof renderer.create>) =>
  tree.root.findAllByType(Text).map(n => n.props.children).flat().filter(x => typeof x === 'string');
const call: any = {
  callId: 'call', callerId: 'self-id', calleeId: peerId, direction: 'outgoing',
  status: 'ended', createdAt: new Date().toISOString(), durationSeconds: 20,
};
const conversation: any = {
  conversationId: 'conversation', peerId, unreadCount: 0,
  lastMessage: { body: 'Hello', createdAt: new Date().toISOString() },
};

test('hook and avatar are safe without a provider and honor supplied names', async () => {
  function Probe() {
    const profile = usePeerProfile(peerId, { displayName });
    return <Text>{profile.name}</Text>;
  }
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<><Probe /><Avatar id={peerId} profile={{ displayName }} /></>);
  });
  expect(texts(tree)).toContain(name);
  expect(texts(tree)).toContain('AL');
});

test('supplied profiles cannot inject an avatar URL outside the authorization boundary', () => {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<Avatar id={peerId} testID="avatar"
      profile={{ displayName, avatarKey: 'key', avatarUrl: 'https://untrusted.example/avatar' } as any} />);
  });
  expect(texts(tree)).toContain('AL');
  expect(tree.root.findAll(n => n.props.testID === 'avatar-image')).toHaveLength(0);
});

test('avatars show authorized images, fail to name initials, and refresh on expiry', async () => {
  const transport = makeTransport();
  const tree = await renderProfile(<Avatar id={peerId} testID="avatar" />, transport);
  expect(node(tree, 'avatar-image').props.source.uri).toBe('https://media.example/avatar');
  act(() => { node(tree, 'avatar-image').props.onError(); });
  expect(texts(tree)).toContain('AL');
  expect(tree.root.findAll(n => n.props.testID === 'avatar-image')).toHaveLength(0);
  await act(async () => { jest.advanceTimersByTime(25_000); });
  expect(transport.authedFetch).toHaveBeenCalledTimes(3); // self plus original and renewed avatar
});

test('renders cached avatar bytes only after the profile authorizes its image', async () => {
  jest.mocked(cacheAvatarImage).mockResolvedValueOnce('/tmp/avatar-cache.jpg');
  const tree = await renderProfile(<Avatar id={peerId} testID="cached-avatar" />);

  expect(node(tree, 'cached-avatar-image').props.source.uri).toBe('file:///tmp/avatar-cache.jpg');
});

test.each(['denied', 'network'])('mounted avatars retry %s failures after the cooldown', async failure => {
  let avatarRequests = 0;
  const transport = makeTransport({
    authedFetch: async build => {
      if (build('session').url.endsWith('/profile')) return response(null);
      avatarRequests += 1;
      if (avatarRequests === 1) {
        if (failure === 'network') throw new Error('offline');
        return { ok: false, json: async () => null } as Response;
      }
      return response({
        userId: peerId, avatarKey: 'key', downloadUrl: 'https://media.example/recovered',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    },
  });
  const tree = await renderProfile(<Avatar id={peerId} testID="avatar" />, transport);
  expect(avatarRequests).toBe(1);
  expect(tree.root.findAll(n => n.props.testID === 'avatar-image')).toHaveLength(0);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(avatarRequests).toBe(2);
  expect(node(tree, 'avatar-image').props.source.uri).toBe('https://media.example/recovered');
});

test('foreground refresh retries an observed denied avatar before its cooldown expires', async () => {
  let listener!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    listener = handler;
    return { remove: jest.fn() };
  });
  let avatarRequests = 0;
  const transport = makeTransport({
    authedFetch: async build => {
      if (build('session').url.endsWith('/profile')) return response(null);
      avatarRequests += 1;
      return avatarRequests === 1 ? { ok: false, json: async () => null } as Response : response({
        userId: peerId, avatarKey: 'key', downloadUrl: 'https://media.example/foreground',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    },
  });
  const tree = await renderProfile(<Avatar id={peerId} testID="avatar" />, transport);
  expect(avatarRequests).toBe(1);
  await act(async () => { listener('background'); listener('active'); });
  expect(avatarRequests).toBe(2);
  expect(node(tree, 'avatar-image').props.source.uri).toBe('https://media.example/foreground');
});

test('ringing avatar image errors fall back to initials', () => {
  let tree!: ReturnType<typeof renderer.create>;
  act(() => {
    tree = renderer.create(<RingingAvatar initials="AD" avatarUrl="https://example/avatar" testID="ring" />);
  });
  act(() => { node(tree, 'ring-image').props.onError(); });
  expect(texts(tree)).toContain('AD');
  expect(tree.root.findAll(n => n.props.testID === 'ring-image')).toHaveLength(0);
});

test('chat list uses the name but opens the raw peer ID', async () => {
  const onOpenConversation = jest.fn();
  const tree = await renderProfile(<ChatListScreen conversations={[conversation]} onOpenConversation={onOpenConversation} />);
  expect(texts(tree)).toContain(name);
  expect(button(tree, 'chat-list-row').props.accessibilityLabel).toContain(name);
  act(() => { button(tree, 'chat-list-row').props.onPress(); });
  expect(onOpenConversation).toHaveBeenCalledWith(peerId);
});

test('history peers outside the bootstrap page resolve exactly without changing routing', async () => {
  const onOpenConversation = jest.fn();
  const transport = makeTransport({
    searchUsers: async () => Array.from({ length: 100 }, (_, i) => ({
      userId: `directory-${i}`, displayName: `Name ${i}`, avatarKey: null,
    })),
    authedFetch: jest.fn(async build => {
      const request = build('session');
      return response(request.url.endsWith('/profile') ? null : {
        users: [{ userId: peerId, displayName: 'Beyond Page', avatarKey: null }],
      });
    }),
  });
  const tree = await renderProfile(
    <ChatListScreen conversations={[conversation]} onOpenConversation={onOpenConversation} />, transport,
  );
  expect(texts(tree)).toContain('Beyond Page');
  act(() => { button(tree, 'chat-list-row').props.onPress(); });
  expect(onOpenConversation).toHaveBeenCalledWith(peerId);
  expect(transport.authedFetch).toHaveBeenCalledTimes(2); // shared self read and deduplicated exact lookup
});

test.each(['network', 'denied', 'missing'])('mounted history peers recover from %s exact lookup failures after the cooldown', async failure => {
  let exactRequests = 0;
  let avatarRequests = 0;
  const onOpenConversation = jest.fn();
  const transport = makeTransport({
    searchUsers: async () => Array.from({ length: 100 }, (_, i) => ({
      userId: `directory-${i}`, displayName: `Name ${i}`, avatarKey: null,
    })),
    authedFetch: async build => {
      const url = build('session').url;
      if (url.endsWith('/profile')) return response(null);
      if (url.includes('/avatar/download')) {
        avatarRequests += 1;
        return response({
          userId: peerId, avatarKey: 'recovered-key', downloadUrl: 'https://media.example/recovered',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
      }
      exactRequests += 1;
      if (exactRequests === 1) {
        if (failure === 'network') throw new Error('offline');
        if (failure === 'denied') return { ok: false, json: async () => null } as Response;
        return response({ users: [] });
      }
      return response({ users: [{ userId: peerId, displayName: 'Recovered Peer', avatarKey: 'recovered-key' }] });
    },
  });
  const tree = await renderProfile(
    <ChatListScreen conversations={[conversation]} onOpenConversation={onOpenConversation} />, transport,
  );
  expect(texts(tree)).toContain(peerId);
  expect(exactRequests).toBe(1);
  expect(avatarRequests).toBe(0);
  await act(async () => { jest.advanceTimersByTime(59_999); });
  expect(exactRequests).toBe(1);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(exactRequests).toBe(2);
  expect(texts(tree)).toContain('Recovered Peer');
  expect(avatarRequests).toBe(1);
  expect(tree.root.findAll(n => n.props.source?.uri === 'https://media.example/recovered').length).toBeGreaterThan(0);
  act(() => { button(tree, 'chat-list-row').props.onPress(); });
  expect(onOpenConversation).toHaveBeenCalledWith(peerId);
});

test('conversation header uses the name while profile and call callbacks remain unchanged', async () => {
  const onOpenProfile = jest.fn();
  const onStartAudioCall = jest.fn();
  const tree = await renderProfile(
    <ChatConversationScreen peerId={peerId} currentUserId="self-id" onBack={jest.fn()}
      messages={[]} onSendMessage={jest.fn()}
      onOpenProfile={onOpenProfile} onStartAudioCall={onStartAudioCall} />,
  );
  expect(texts(tree)).toContain(name);
  const profileButton = tree.root.findAll(n => n.props.accessibilityLabel === `${name} profile` && n.props.onPress)[0];
  act(() => { profileButton.props.onPress(); });
  expect(onOpenProfile).toHaveBeenCalledTimes(1);
  const callButton = tree.root.findAll(n => n.props.accessibilityLabel === `Call ${name}` && n.props.onPress)[0];
  act(() => { callButton.props.onPress(); });
  expect(onStartAudioCall).toHaveBeenCalledTimes(1);
});

test('call history and lobby route with IDs while displaying names', async () => {
  const onOpenProfile = jest.fn();
  const onAudioCall = jest.fn();
  const onVideoCall = jest.fn();
  const tree = await renderProfile(
    <CallsScreen callHistory={[call]} onOpenProfile={onOpenProfile} onAudioCall={onAudioCall} onVideoCall={onVideoCall} />,
  );
  expect(texts(tree)).toContain(name);
  expect(button(tree, 'call-history-row').props.accessibilityLabel).toContain(name);
  act(() => { button(tree, 'call-history-row').props.onPress(); });
  expect(onOpenProfile).toHaveBeenCalledWith(peerId);
  act(() => { button(tree, 'call-history-redial').props.onPress(); });
  expect(onAudioCall).not.toHaveBeenCalled(); // video history must not become an audio call
  expect(onVideoCall).toHaveBeenCalledWith(peerId);
});

test('incoming and outgoing screens resolve the peer name and avatar', async () => {
  const incoming: any = { ...call, callerId: peerId, calleeId: 'self-id', status: 'ringing' };
  const tree = await renderProfile(
    <>
      <IncomingCallScreen incomingCall={incoming} status={{} as any} onAccept={jest.fn()} onDecline={jest.fn()} />
      <OutgoingCallScreen calleeId={peerId} status={{} as any} onCancel={jest.fn()} />
    </>,
  );
  expect(node(tree, 'incoming-caller-id').props.accessibilityLabel).toBe(`Incoming call from ${name}`);
  expect(node(tree, 'outgoing-callee-id').props.accessibilityLabel).toBe(`Calling ${name}`);
  expect(node(tree, 'incoming-avatar-image').props.source.uri).toBe('https://media.example/avatar');
  expect(node(tree, 'outgoing-avatar-image').props.source.uri).toBe('https://media.example/avatar');
  act(() => {
    node(tree, 'incoming-avatar-image').props.onError();
    node(tree, 'outgoing-avatar-image').props.onError();
  });
  expect(texts(tree).filter(text => text === 'AL')).toHaveLength(2);
});

test('incoming connecting accessibility announces the resolved name rather than raw ID', async () => {
  const tree = await renderProfile(
    <IncomingCallScreen incomingCall={{ ...call, callerId: peerId }} isAnswering
      status={{} as any} onAccept={jest.fn()} onDecline={jest.fn()} />,
  );
  expect(node(tree, 'incoming-connecting').props.accessibilityLabel).toBe(`Connecting to ${name}`);
});

test('peer profile actions and mute/block controls keep raw IDs', async () => {
  const onMessage = jest.fn();
  const onAudioCall = jest.fn();
  const onToggleMute = jest.fn();
  const onBlock = jest.fn();
  const tree = await renderProfile(
    <PeerProfileScreen peerId={peerId} onMessage={onMessage} onAudioCall={onAudioCall}
      onToggleMute={onToggleMute} onBlock={onBlock} />,
  );
  expect(texts(tree)).toContain(name);
  expect(node(tree, 'peer-profile-user-id').props.children)
    .toBe(`Username (stable identity): ${peerId}`);
  act(() => { button(tree, 'peer-profile-message').props.onPress(); });
  act(() => { button(tree, 'peer-profile-audio-call').props.onPress(); });
  const mute = tree.root.findAll(n => n.props.testID === 'peer-profile-mute' && n.props.onValueChange)[0];
  act(() => { mute.props.onValueChange(true); });
  await act(async () => { await button(tree, 'peer-profile-block').props.onPress(); });
  expect(onMessage).toHaveBeenCalledWith(peerId);
  expect(onAudioCall).toHaveBeenCalledWith(peerId);
  expect(onToggleMute).toHaveBeenCalledWith(peerId);
  expect(onBlock).toHaveBeenCalledWith(peerId);
});

test('settings self/muted/blocked names resolve, retain raw account ID, and deny blocked images', async () => {
  const onUnmutePeer = jest.fn();
  const onUnblockUser = jest.fn();
  const onSaveDisplayName = jest.fn().mockResolvedValue('Updated Self Name');
  const transport = makeTransport();
  const screen = <SettingsScreen userId="self-id" signalingUrl="https://signal.example"
    onSaveSignalingUrl={jest.fn()} onSaveDisplayName={onSaveDisplayName}
    onSignOut={jest.fn()} onClose={jest.fn()} mutedPeers={[peerId]}
    blockedUsers={[peerId]} onUnmutePeer={onUnmutePeer} onUnblockUser={onUnblockUser} />;
  const tree = await renderProfile(screen, transport);
  await act(async () => {
    tree.update(<ProfileDataProvider transport={transport} blockedUsers={[peerId]}>{screen}</ProfileDataProvider>);
  });
  expect(texts(tree)).toContain('Self Name');
  expect(node(tree, 'settings-username-row').props.value).toBe('self-id');
  expect(node(tree, 'settings-muted-row').props.title).toBe(name);
  expect(node(tree, 'settings-blocked-row').props.title).toBe(name);
  act(() => { button(tree, 'settings-display-name-row').props.onPress(); });
  act(() => {
    tree.root.findAll(n => n.props.testID === 'settings-display-name-input'
      && typeof n.props.onChangeText === 'function')[0].props.onChangeText('Updated Self Name');
  });
  await act(async () => { await button(tree, 'settings-save-display-name').props.onPress(); });
  expect(onSaveDisplayName).toHaveBeenCalledWith('Updated Self Name');
  expect(texts(tree)).toContain('Updated Self Name');
  expect(tree.root.findAllByType(Avatar).filter(n => n.props.id === peerId)
    .every(n => n.findAll(nested => nested.props.source?.uri).length === 0)).toBe(true);
  act(() => { button(tree, 'settings-unmute').props.onPress(); });
  act(() => { button(tree, 'settings-unblock').props.onPress(); });
  expect(onUnmutePeer).toHaveBeenCalledWith(peerId);
  expect(onUnblockUser).toHaveBeenCalledWith(peerId);
});

test('all search categories display names while callbacks retain raw IDs', async () => {
  const onOpenProfile = jest.fn();
  const onOpenConversation = jest.fn();
  const onOpenMessage = jest.fn();
  const tree = await renderProfile(
    <SearchScreen conversations={[conversation]} callHistory={[call]} currentUserId="self-id"
      onSearchContacts={async () => [{ userId: peerId, displayName }]}
      onSearchMessages={async () => [{ peerId, messageId: 'message', body: 'peer text' }]}
      onOpenProfile={onOpenProfile} onOpenConversation={onOpenConversation} onOpenMessage={onOpenMessage} />,
  );
  act(() => { node(tree, 'search-input').props.onChangeText('peer'); });
  await act(async () => { jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS); });
  for (const id of ['search-contact-row', 'search-conversation-row', 'search-message-row', 'search-call-row']) {
    expect(button(tree, id).props.accessibilityLabel).toContain(name);
    act(() => { button(tree, id).props.onPress(); });
  }
  expect(onOpenProfile).toHaveBeenNthCalledWith(1, peerId);
  expect(onOpenProfile).toHaveBeenNthCalledWith(2, peerId);
  expect(onOpenConversation).toHaveBeenCalledWith(peerId);
  expect(onOpenMessage).toHaveBeenCalledWith({ peerId, messageId: 'message' });
});

test('person picker supplied profiles work without provider and selection stays raw', async () => {
  const onSelect = jest.fn();
  let tree!: ReturnType<typeof renderer.create>;
  await act(async () => {
    tree = renderer.create(<PeoplePickerSheet visible title="New call" onClose={jest.fn()}
      onSearchUsers={async () => [{ userId: peerId, displayName }]} onSelect={onSelect} />);
    jest.advanceTimersByTime(300);
  });
  act(() => { node(tree, 'people-picker-search').props.onChangeText('peer'); });
  await act(async () => { jest.advanceTimersByTime(300); });
  const row = tree.root.findAllByType(ListItem).find(n => n.props.testID === 'people-picker-row')!;
  expect(row.props.title).toBe(name);
  act(() => { row.props.onPress?.(); });
  expect(onSelect).toHaveBeenCalledWith(peerId);
});

test('provider resets on account/server changes and ignores late responses', async () => {
  let finish!: (rows: any[]) => void;
  const old = makeTransport({
    searchUsers: () => new Promise(resolve => { finish = resolve; }),
  });
  const tree = await renderProfile(<Avatar id={peerId} testID="avatar" />, old);
  const next = makeTransport({
    userId: 'other-self', signalingUrl: 'https://other.example',
    searchUsers: async () => [{ userId: peerId, displayName: 'New Name' }],
    authedFetch: async () => response(null),
  });
  await act(async () => {
    tree.update(<ProfileDataProvider transport={next}><Avatar id={peerId} testID="avatar" /></ProfileDataProvider>);
    finish([{ userId: peerId, displayName: 'Stale Name', avatarKey: 'old-key' }]);
  });
  expect(texts(tree)).toContain('NN');
  expect(texts(tree)).not.toContain('ST');
  expect(tree.root.findAll(n => n.props.testID === 'avatar-image')).toHaveLength(0);
});

test('Strict Mode effect replay does not dispose the live profile store', async () => {
  let tree!: ReturnType<typeof renderer.create>;
  const transport = makeTransport();
  await act(async () => {
    tree = renderer.create(
      <StrictMode><ProfileDataProvider transport={transport}><Avatar id={peerId} /></ProfileDataProvider></StrictMode>,
    );
  });
  expect(texts(tree)).not.toContain('RA');
  expect(tree.root.findAll(n => n.props.source?.uri === 'https://media.example/avatar').length).toBeGreaterThan(0);
});

test('AppState foreground refresh updates a mounted name and removes the scoped listener', async () => {
  let listener!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    listener = handler;
    return { remove };
  });
  let currentName = 'Old Name';
  const transport = makeTransport({
    searchUsers: jest.fn(async () => [{ userId: peerId, displayName: currentName, avatarKey: null }]),
    authedFetch: async () => response(null),
  });
  const tree = await renderProfile(<Avatar id={peerId} />, transport);
  expect(texts(tree)).toContain('ON');
  currentName = 'New Name';
  await act(async () => { listener('background'); listener('active'); });
  expect(texts(tree)).toContain('NN');
  expect(transport.searchUsers).toHaveBeenLastCalledWith('', { limit: 100, forceRefresh: true });
  act(() => { tree.unmount(); });
  expect(remove).toHaveBeenCalledTimes(1);
});
