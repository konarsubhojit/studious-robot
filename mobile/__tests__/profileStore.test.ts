import { resolveDisplayName } from '../../shared/identity';
import { createProfileStore } from '../src/profile/profileStore';
import { bearerAuthHeaders } from '../src/authHeaders';
import type { ProfileStore, ProfileTransport } from '../src/profile/profileStore';

const response = (value: unknown, ok = true) => ({ ok, json: async () => value } as Response);
const signed = (url = 'https://media.example/avatar', userId = 'peer', avatarKey = 'key') => ({
  userId, avatarKey, downloadUrl: url, expiresAt: new Date(Date.now() + 30_000).toISOString(),
});

function setup(overrides: Partial<ProfileTransport> = {}) {
  const authedFetch = jest.fn(async () => response(null));
  const searchUsers = jest.fn(async () => []);
  const transport: ProfileTransport = {
    signalingUrl: 'https://signal.example', userId: 'self', authedFetch, searchUsers, ...overrides,
  };
  const store = createProfileStore(transport);
  stores.push(store);
  return { store, authedFetch, searchUsers };
}

const stores: ProfileStore[] = [];
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  stores.splice(0).forEach(store => store.dispose());
  jest.useRealTimers();
});

test.each([
  ['  Ada Lovelace  ', 'Ada Lovelace'],
  ['', 'raw-id'],
  ['  ', 'raw-id'],
  [null, 'raw-id'],
  [undefined, 'raw-id'],
])('shared name resolver handles %p', (name, expected) => {
  expect(resolveDisplayName('raw-id', name)).toBe(expected);
});

test('directory and self reads are batched, names resolved, and presence excluded', async () => {
  const searchUsers = jest.fn(async () => [
      { userId: 'peer', displayName: '  Ada  ', avatarKey: 'key', online: true },
  ]);
  const authedFetch = jest.fn(async () => response({ displayName: 'Self Name', avatarKey: null }));
  const { store } = setup({ searchUsers, authedFetch });
  await Promise.all([store.loadDirectory(), store.loadDirectory(), store.loadDirectory()]);
  expect(store.get('peer')).toEqual({ userId: 'peer', name: 'Ada', displayName: '  Ada  ', avatarKey: 'key', avatarUrl: undefined });
  expect(store.get('self').name).toBe('Self Name');
  expect(store.get('unknown').name).toBe('unknown');
  expect(authedFetch).toHaveBeenCalledTimes(1);
  expect(searchUsers).toHaveBeenCalledTimes(1);
});

test('one directory request serves many identities and does not fetch their avatars', async () => {
  const searchUsers = jest.fn(async () => Array.from({ length: 50 }, (_, i) => ({
    userId: `id-${i}`, displayName: `Name ${i}`, avatarKey: `key-${i}`,
  })));
  const authedFetch = jest.fn(async (_request: Parameters<ProfileTransport['authedFetch']>[0]) => response(null));
  const { store } = setup({ searchUsers, authedFetch });
  await Promise.all(Array.from({ length: 50 }, () => store.loadDirectory()));
  expect(searchUsers).toHaveBeenCalledTimes(1);
  expect(searchUsers).toHaveBeenCalledWith('', { limit: 100 });
  expect(authedFetch).toHaveBeenCalledTimes(1);
  expect(authedFetch.mock.calls[0][0]('session').url).toBe('https://signal.example/profile');
});

test('avatar reads deduplicate and authenticate with the raw encoded ID', async () => {
  const authedFetch = jest.fn(async (_request: Parameters<ProfileTransport['authedFetch']>[0]) => response(signed(undefined, 'raw/id')));
  const { store } = setup({ authedFetch });
  store.seed('raw/id', { displayName: 'Name', avatarKey: 'key' });
  await Promise.all([store.ensureAvatar('raw/id'), store.ensureAvatar('raw/id')]);
  await store.ensureAvatar('raw/id');
  expect(authedFetch).toHaveBeenCalledTimes(1);
  expect(authedFetch.mock.calls[0][0]('session')).toEqual({
    url: 'https://signal.example/avatar/download?userId=raw%2Fid',
    options: { headers: bearerAuthHeaders('session') },
  });
  expect(store.get('raw/id').avatarUrl).toBe('https://media.example/avatar');
});

test('avatars expire before their signed deadline and can be renewed', async () => {
  const authedFetch = jest.fn(async () => response(signed()));
  const { store } = setup({ authedFetch });
  store.seed('peer', { avatarKey: 'key' });
  await store.ensureAvatar('peer');
  jest.advanceTimersByTime(25_000);
  expect(store.get('peer').avatarUrl).toBeUndefined();
  await store.ensureAvatar('peer');
  expect(authedFetch).toHaveBeenCalledTimes(2);
  expect(store.get('peer').avatarUrl).toBeDefined();
});

test('download response supplies the authoritative avatar key, not the stale directory key', async () => {
  const { store } = setup({
    authedFetch: async () => response(signed('https://media.example/new', 'peer', 'current-key')),
  });
  store.seed('peer', { displayName: 'Ada', avatarKey: 'stale-directory-key' });
  await store.ensureAvatar('peer');
  expect(store.get('peer').avatarKey).toBe('current-key');
  expect(store.get('peer').avatarUrl).toBe('https://media.example/new');
});

test.each([
  { ...signed(), userId: 'other-peer' },
  { ...signed(), avatarKey: null },
  { ...signed(), avatarKey: '   ' },
  { downloadUrl: 'https://media.example/avatar', expiresAt: '2099-01-01' },
])('rejects download owner/key inconsistency %p', async result => {
  const { store } = setup({ authedFetch: async () => response(result) });
  store.seed('peer', { avatarKey: 'key' });
  await store.ensureAvatar('peer');
  expect(store.get('peer').avatarUrl).toBeUndefined();
  expect(store.get('peer').avatarKey).toBe('key');
});

test('signed URL timers stop offscreen and expired cached URLs are not reused on read', async () => {
  const authedFetch = jest.fn(async () => response(signed()));
  const { store } = setup({ authedFetch });
  store.seed('peer', { avatarKey: 'key' });
  await store.ensureAvatar('peer');
  expect(jest.getTimerCount()).toBe(0);
  const unwatch = store.watch('peer');
  expect(jest.getTimerCount()).toBe(1);
  unwatch();
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(60_000);
  expect(store.get('peer').avatarUrl).toBeUndefined();
  expect(authedFetch).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('failed avatar cooldowns do not rearm retry timers for offscreen peers', async () => {
  const authedFetch = jest.fn(async () => response(null, false));
  const { store } = setup({ authedFetch });
  store.seed('peer', { avatarKey: 'key' });
  const unwatch = store.watch('peer');
  await store.ensureAvatar('peer');
  expect(jest.getTimerCount()).toBe(1);
  unwatch();
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(10 * 60_000);
  store.watch('peer');
  jest.advanceTimersByTime(1);
  expect(jest.getTimerCount()).toBe(0);
  expect(authedFetch).toHaveBeenCalledTimes(1);
});

test('an observed failed-avatar deadline publishes a fresh snapshot even without a URL', async () => {
  const { store } = setup({ authedFetch: async () => response(null, false) });
  store.seed('peer', { avatarKey: 'key' });
  store.watch('peer');
  await store.ensureAvatar('peer');
  const previous = store.get('peer');
  jest.advanceTimersByTime(60_000);
  expect(store.get('peer')).not.toBe(previous);
  expect(store.get('peer').avatarUrl).toBeUndefined();
});

test.each([
  response(null, false),
  response({ ...signed(), downloadUrl: 'file:///private/avatar', expiresAt: '2099-01-01' }),
  response({ ...signed(), expiresAt: 'invalid' }),
  response({ ...signed(), expiresAt: '2000-01-01' }),
])('unauthorized or invalid avatars fall back and do not cascade retries', async result => {
  const authedFetch = jest.fn(async () => result);
  const { store } = setup({ authedFetch });
  store.seed('peer', { displayName: 'Ada', avatarKey: 'key' });
  await store.ensureAvatar('peer');
  await store.ensureAvatar('peer');
  expect(store.get('peer').name).toBe('Ada');
  expect(store.get('peer').avatarUrl).toBeUndefined();
  expect(authedFetch).toHaveBeenCalledTimes(1);
});

test('network errors and missing avatar keys are safe', async () => {
  const authedFetch = jest.fn(async () => { throw new Error('offline'); });
  const { store } = setup({ authedFetch });
  await store.ensureAvatar('unknown');
  expect(authedFetch).not.toHaveBeenCalled();
  store.seed('peer', { avatarKey: 'key' });
  await store.ensureAvatar('peer');
  await store.loadDirectory();
  expect(store.get('peer').avatarUrl).toBeUndefined();
});

test('signed-out stores never fetch profiles, directory or avatar URLs', async () => {
  const { store, authedFetch, searchUsers } = setup({ userId: '' });
  store.seed('peer', { displayName: 'Known Name', avatarKey: 'key' });
  store.watch('peer');
  await Promise.all([
    store.loadDirectory(), store.ensureProfile('unknown'),
    store.ensureAvatar('peer'), store.refreshProfiles(),
  ]);
  expect(authedFetch).not.toHaveBeenCalled();
  expect(searchUsers).not.toHaveBeenCalled();
  expect(store.get('peer').avatarUrl).toBeUndefined();
});

test('blocking retains a known name but clears cached avatar authorization', async () => {
  const authedFetch = jest.fn(async () => response(signed()));
  const { store } = setup({ authedFetch });
  store.seed('peer', { displayName: 'Ada', avatarKey: 'key' });
  await store.ensureAvatar('peer');
  store.setBlocked(['peer']);
  await store.ensureAvatar('peer');
  expect(store.get('peer').name).toBe('Ada');
  expect(store.get('peer').avatarUrl).toBeUndefined();
  expect(authedFetch).toHaveBeenCalledTimes(1);
  store.setBlocked([]);
  await store.ensureAvatar('peer');
  expect(authedFetch).toHaveBeenCalledTimes(2);
});

test('in-flight avatar responses cannot restore blocked images', async () => {
  let finish!: (response: Response) => void;
  const { store } = setup({
    authedFetch: () => new Promise(resolve => { finish = resolve; }),
  });
  store.seed('peer', { displayName: 'Ada', avatarKey: 'key' });
  const pending = store.ensureAvatar('peer');
  store.setBlocked(['peer']);
  finish(response(signed()));
  await pending;
  expect(store.get('peer').name).toBe('Ada');
  expect(store.get('peer').avatarUrl).toBeUndefined();
});

test('disposed scopes ignore late directory and avatar results', async () => {
  let finishDirectory!: (rows: any[]) => void;
  let directoryStarted!: () => void;
  const started = new Promise<void>(resolve => { directoryStarted = resolve; });
  const fetchResolvers: ((value: Response) => void)[] = [];
  const { store } = setup({
    searchUsers: () => {
      directoryStarted();
      return new Promise(resolve => { finishDirectory = resolve; });
    },
    authedFetch: () => new Promise(resolve => { fetchResolvers.push(resolve); }),
  });
  store.seed('peer', { avatarKey: 'key' });
  const directory = store.loadDirectory();
  fetchResolvers[0](response(null));
  // Let the directory start after the authenticated self request established its session.
  await started;
  const avatar = store.ensureAvatar('peer');
  store.dispose();
  finishDirectory([{ userId: 'peer', displayName: 'Late Name' }]);
  fetchResolvers[1](response(signed()));
  await Promise.all([directory, avatar]);
  expect(store.get('peer').name).toBe('peer');
  expect(store.get('peer').avatarUrl).toBeUndefined();
  expect(store.get('self').name).toBe('self');
});

test('disposed scopes ignore late self profiles without starting directory requests', async () => {
  let finish!: (value: Response) => void;
  const searchUsers = jest.fn(async () => []);
  const { store } = setup({
    searchUsers, authedFetch: () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = store.loadDirectory();
  store.dispose();
  finish(response({ displayName: 'Late Self' }));
  await pending;
  expect(store.get('self').name).toBe('self');
  expect(searchUsers).not.toHaveBeenCalled();
});

test('self request establishes the session before directory lookup', async () => {
  let authenticated = false;
  const { store } = setup({
    authedFetch: async () => { authenticated = true; return response(null); },
    searchUsers: async () => {
      expect(authenticated).toBe(true);
      return [{ userId: 'peer', displayName: 'Ready' }];
    },
  });
  await store.loadDirectory();
  expect(store.get('peer').name).toBe('Ready');
});

test('peers beyond the bootstrap page get one exact, deduplicated lookup', async () => {
  const id = 'beyond/page';
  const authedFetch = jest.fn(async (build: Parameters<ProfileTransport['authedFetch']>[0]) => {
    const url = build('session').url;
    return response(url.endsWith('/profile') ? null : {
      users: [{ userId: id, displayName: 'Beyond Page', avatarKey: null }],
    });
  });
  const { store } = setup({
    authedFetch,
    searchUsers: async () => Array.from({ length: 100 }, (_, i) => ({
      userId: `sorted-${i}`, displayName: `Name ${i}`, avatarKey: null,
    })),
  });
  await Promise.all([store.ensureProfile(id), store.ensureProfile(id), store.ensureProfile(id)]);
  expect(store.get(id).name).toBe('Beyond Page');
  expect(authedFetch).toHaveBeenCalledTimes(2);
  expect(authedFetch.mock.calls[1][0]('session').url)
    .toBe('https://signal.example/users?userId=beyond%2Fpage');
  await store.ensureProfile(id);
  await store.ensureProfile('sorted-0');
  expect(authedFetch).toHaveBeenCalledTimes(2);
});

test('exact missing-profile lookups have bounded concurrency and reject disposed results', async () => {
  const resolvers: ((value: Response) => void)[] = [];
  const authedFetch = jest.fn(async (build: Parameters<ProfileTransport['authedFetch']>[0]) => {
    if (build('session').url.endsWith('/profile')) return response(null);
    return new Promise<Response>(resolve => { resolvers.push(resolve); });
  });
  const { store } = setup({ authedFetch });
  await store.loadDirectory();
  const requests = ['a', 'b', 'c', 'd'].map(id => store.ensureProfile(id));
  // Each ensureProfile continuation queues work after the shared bootstrap.
  await Promise.resolve();
  await Promise.resolve();
  expect(resolvers).toHaveLength(2);
  resolvers[0](response({ users: [{ userId: 'a', displayName: 'Alice' }] }));
  await requests[0];
  expect(resolvers).toHaveLength(3);
  store.dispose();
  // The queued fourth request is released without hitting the server.
  expect(resolvers).toHaveLength(3);
  resolvers[1](response({ users: [{ userId: 'b', displayName: 'Late Bob' }] }));
  resolvers[2](response({ users: [{ userId: 'c', displayName: 'Late Carol' }] }));
  await Promise.all(requests);
  expect(store.get('a').name).toBe('Alice');
  expect(store.get('b').name).toBe('b');
  expect(store.get('c').name).toBe('c');
});

test('missing, denied and blocked exact lookups do not cascade retries', async () => {
  const authedFetch = jest.fn(async () => response(null, false));
  const { store } = setup({ authedFetch });
  store.setBlocked(['blocked']);
  await store.ensureProfile('blocked');
  expect(authedFetch).not.toHaveBeenCalled();
  await store.ensureProfile('missing');
  await store.ensureProfile('missing');
  expect(authedFetch).toHaveBeenCalledTimes(2); // bootstrap self plus one exact peer read
  expect(store.get('missing').name).toBe('missing');
});

test('foreground refresh coalesces, bypasses cached names, and refreshes self', async () => {
  let name = 'Old Name';
  const searchUsers = jest.fn(async () => [{ userId: 'peer', displayName: name, avatarKey: null }]);
  const authedFetch = jest.fn(async () => response({ displayName: name }));
  const { store } = setup({ searchUsers, authedFetch });
  store.watch('peer');
  await store.loadDirectory();
  expect(store.get('peer').name).toBe('Old Name');
  name = 'New Name';
  await Promise.all([store.refreshProfiles(), store.refreshProfiles()]);
  expect(store.get('peer').name).toBe('New Name');
  expect(store.get('self').name).toBe('New Name');
  expect(searchUsers).toHaveBeenCalledTimes(2);
  expect(searchUsers).toHaveBeenLastCalledWith('', { limit: 100, forceRefresh: true });
});

test('foreground refresh targets only watched peers beyond the bootstrap and preserves blocked names', async () => {
  let name = 'Old Name';
  const urls: string[] = [];
  const { store } = setup({
    authedFetch: async build => {
      const url = build('session').url;
      urls.push(url);
      const userId = url.split('userId=')[1];
      return response(userId ? { users: [{ userId, displayName: name, avatarKey: null }] } : null);
    },
  });
  const unwatch = store.watch('unmounted');
  store.watch('visible');
  store.watch('blocked');
  await Promise.all(['unmounted', 'visible', 'blocked'].map(id => store.ensureProfile(id)));
  unwatch();
  store.setBlocked(['blocked']);
  name = 'New Name';
  const before = urls.length;
  await store.refreshProfiles();
  expect(urls.slice(before)).toEqual([
    'https://signal.example/profile',
    'https://signal.example/users?userId=visible',
  ]);
  expect(store.get('visible').name).toBe('New Name');
  expect(store.get('unmounted').name).toBe('Old Name');
  expect(store.get('blocked').name).toBe('Old Name');
});

test('late foreground refresh results cannot update a disposed account/server scope', async () => {
  let finish!: (rows: any[]) => void;
  let onStarted!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  const searchUsers = jest.fn()
    .mockResolvedValueOnce([{ userId: 'peer', displayName: 'Old Name', avatarKey: null }])
    .mockImplementationOnce(() => {
      onStarted();
      return new Promise(resolve => { finish = resolve; });
    });
  const { store } = setup({ searchUsers });
  await store.loadDirectory();
  const refresh = store.refreshProfiles();
  await started;
  store.dispose();
  finish([{ userId: 'peer', displayName: 'Stale Other Scope', avatarKey: 'late-key' }]);
  await refresh;
  expect(store.get('peer').name).toBe('Old Name');
  expect(store.get('peer').avatarKey).toBeNull();
});

test.each([200, 403])('exact lookup hidden/missing response %s removes previously authorized avatars', async status => {
  let hidden = false;
  let avatarRequests = 0;
  const { store } = setup({
    authedFetch: async build => {
      const url = build('session').url;
      if (url.includes('/avatar/download')) {
        avatarRequests += 1;
        return response(signed());
      }
      if (url.endsWith('/profile')) return response(null);
      return response({
        users: hidden ? [] : [{ userId: 'peer', displayName: 'Retained Name', avatarKey: 'key' }],
      }, !hidden || status === 200);
    },
  });
  store.watch('peer');
  await store.ensureProfile('peer');
  await store.ensureAvatar('peer');
  expect(store.get('peer').avatarUrl).toBeDefined();
  hidden = true;
  await store.refreshProfiles();
  expect(store.get('peer').name).toBe('Retained Name');
  expect(store.get('peer').avatarKey).toBeNull();
  expect(store.get('peer').avatarUrl).toBeUndefined();
  await store.ensureAvatar('peer');
  expect(avatarRequests).toBe(1);
});

test('late download cannot restore an avatar after exact lookup loses visibility', async () => {
  let finish!: (value: Response) => void;
  const { store } = setup({
    authedFetch: async build => build('session').url.includes('/avatar/download')
      ? new Promise(resolve => { finish = resolve; }) : response(null, false),
  });
  store.seed('peer', { displayName: 'Retained Name', avatarKey: 'key' });
  store.watch('peer');
  const download = store.ensureAvatar('peer');
  await store.refreshProfiles();
  finish(response(signed()));
  await download;
  expect(store.get('peer').name).toBe('Retained Name');
  expect(store.get('peer').avatarKey).toBeNull();
  expect(store.get('peer').avatarUrl).toBeUndefined();
});

test('a changed avatar key rejects an old URL and loads the replacement', async () => {
  let finish!: (value: Response) => void;
  const authedFetch = jest.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(response(signed('https://media.example/new', 'peer', 'new')));
  const { store } = setup({ authedFetch });
  store.seed('peer', { avatarKey: 'old' });
  const pending = store.ensureAvatar('peer');
  store.seed('peer', { avatarKey: 'new' });
  finish(response(signed('https://media.example/old', 'peer', 'old')));
  await pending;
  await store.ensureAvatar('peer');
  expect(store.get('peer').avatarUrl).toBe('https://media.example/new');
});
