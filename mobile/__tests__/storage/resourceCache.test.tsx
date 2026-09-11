import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { dataScope, withDatabase } from '../../src/storage/localDatabase';
import * as cache from '../../src/storage/resourceCache';
import useCachedResource from '../../src/storage/useCachedResource';
import usePresenceSearch from '../../src/hooks/usePresenceSearch';
import { RequestCoalescer } from '../../src/storage/requestCoalescer';

jest.mock('../../src/appLogger', () => ({ logWarn: jest.fn() }));

const server = 'https://example.test';
const alice = dataScope(server, 'alice');
const bob = dataScope(server, 'bob');
let tree: renderer.ReactTestRenderer;
let resource: ReturnType<typeof useCachedResource<string[]>>;
let directory: ReturnType<typeof usePresenceSearch>;

function Resource({ scope }: { scope: string }) {
  resource = useCachedResource<string[]>(scope, 'blocks', []);
  return null;
}

const authedFetchRef = { current: jest.fn() };
const sessionIdRef = { current: 'session' };
function Directory() {
  directory = usePresenceSearch({ signalingUrl: server, userId: 'alice', calleeId: '', authedFetchRef, sessionIdRef });
  return null;
}

beforeEach(async () => {
  jest.restoreAllMocks();
  authedFetchRef.current.mockReset();
  await withDatabase(async db => { await db.execute('DELETE FROM resource_cache'); });
});
afterEach(async () => {
  await act(async () => { tree?.unmount(); });
  await withDatabase(async () => {});
});

test('scope includes account and server but normalizes surrounding whitespace and trailing slashes', () => {
  expect(dataScope(` ${server}/ `, ' alice ')).toBe(alice);
  expect(alice).not.toBe(bob);
  expect(alice).not.toBe(dataScope('https://other.test', 'alice'));
  expect(dataScope(server, '')).toBe('');
});

test('hydrates a durable resource offline and persists subsequent changes', async () => {
  await cache.writeResource(alice, 'blocks', ['blocked']);
  await act(async () => { tree = renderer.create(<Resource scope={alice} />); });
  expect(resource[0]).toEqual(['blocked']);
  await act(async () => { resource[1](['next']); });
  expect((await cache.readResource<string[]>(alice, 'blocks'))?.value).toEqual(['next']);
});

test('late disk hydration cannot replace an authoritative empty server response', async () => {
  let resolve!: (value: cache.CachedResource<string[]>) => void;
  jest.spyOn(cache, 'readResource').mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await act(async () => { tree = renderer.create(<Resource scope={alice} />); });
  await act(async () => {
    resource[1]([]);
    resolve({ value: ['old'], updatedAt: Date.now() });
  });
  expect(resource[0]).toEqual([]);
});

test('switching accounts hides the previous cache and rejects old request callbacks', async () => {
  await cache.writeResource(alice, 'blocks', ['alice-only']);
  await cache.writeResource(bob, 'blocks', ['bob-only']);
  await act(async () => { tree = renderer.create(<Resource scope={alice} />); });
  const oldUpdate = resource[1];
  await act(async () => { tree.update(<Resource scope={bob} />); });
  await act(async () => { oldUpdate(['must-not-leak']); });
  expect(resource[0]).toEqual(['bob-only']);
  expect((await cache.readResource<string[]>(bob, 'blocks'))?.value).toEqual(['bob-only']);
});

test('directory cache avoids duplicate network reads and never persists live presence', async () => {
  authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({ users: [{ userId: 'bob', online: true }] }) });
  await act(async () => { tree = renderer.create(<Directory />); });
  expect(await directory.searchUsers('bo')).toEqual([{ userId: 'bob', online: true }]);
  expect(await directory.searchUsers('bo')).toEqual([{ userId: 'bob' }]);
  expect(authedFetchRef.current).toHaveBeenCalledTimes(1);
});

test('expired directory cache is an offline fallback but never overrides an authorization denial', async () => {
  const key = 'directory:["bo",20]';
  await cache.writeResource(alice, key, [{ userId: 'bob' }]);
  await withDatabase(async db => {
    await db.execute('UPDATE resource_cache SET updated_at = ? WHERE scope = ?', [Date.now() - 120_000, alice]);
  });
  await act(async () => { tree = renderer.create(<Directory />); });
  authedFetchRef.current.mockRejectedValueOnce(new Error('offline'));
  expect(await directory.searchUsers('bo')).toEqual([{ userId: 'bob' }]);
  authedFetchRef.current.mockResolvedValueOnce({ ok: false, status: 403 });
  await expect(directory.searchUsers('bo')).rejects.toThrow('403');
});

test('block changes invalidate cached queries and fence pre-block responses', async () => {
  const version = cache.directoryVersion(alice);
  await cache.writeResource(alice, 'directory:old', [{ userId: 'bob' }], version);
  await cache.invalidateDirectory(alice);
  await cache.writeResource(alice, 'directory:late', [{ userId: 'bob' }], version);
  expect(await cache.readResource(alice, 'directory:old')).toBeNull();
  expect(await cache.readResource(alice, 'directory:late')).toBeNull();
});

test('directory retention is bounded without pruning durable call or block state', async () => {
  await cache.writeResource(alice, 'calls', ['call']);
  for (let index = 0; index < 40; index += 1) {
    await cache.writeResource(alice, `directory:${index}`, []);
  }
  const rows = await withDatabase(db =>
    db.execute("SELECT key FROM resource_cache WHERE scope = ? AND key LIKE 'directory:%'", [alice]));
  expect(rows.rows).toHaveLength(30);
  expect((await cache.readResource(alice, 'calls'))?.value).toEqual(['call']);
});

test('a backward device clock does not keep a directory entry fresh indefinitely', async () => {
  await cache.writeResource(alice, 'directory:["bo",20]', [{ userId: 'old' }]);
  await withDatabase(async db => {
    await db.execute('UPDATE resource_cache SET updated_at = ? WHERE scope = ?', [Date.now() + 3_600_000, alice]);
  });
  authedFetchRef.current.mockResolvedValue({ ok: true, json: async () => ({ users: [{ userId: 'new' }] }) });
  await act(async () => { tree = renderer.create(<Directory />); });
  expect(await directory.searchUsers('bo')).toEqual([{ userId: 'new' }]);
  expect(authedFetchRef.current).toHaveBeenCalledTimes(1);
});

test('simultaneous refreshes coalesce, while subsequent refreshes and failures remain retryable', async () => {
  const requests = new RequestCoalescer();
  const work = jest.fn(async () => 'fresh');
  await Promise.all([requests.run('calls', work), requests.run('calls', work)]);
  expect(work).toHaveBeenCalledTimes(1);
  await requests.run('calls', work);
  expect(work).toHaveBeenCalledTimes(2);
  await expect(requests.run('calls', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(await requests.run('calls', work)).toBe('fresh');
});
