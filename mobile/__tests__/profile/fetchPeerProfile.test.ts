import { fetchPeerProfile } from '../../src/profile/fetchPeerProfile';
import { bearerAuthHeaders } from '../../src/authHeaders';

describe('fetchPeerProfile', () => {
  const options = { signalingUrl: 'https://server.example/', userId: 'bob / study' };

  test('uses an authenticated exact lookup and ignores other rows and URLs', async () => {
    const authedFetch = jest.fn(async makeRequest => {
      expect(makeRequest('session')).toEqual({
        url: 'https://server.example/users?userId=bob%20%2F%20study',
        options: { headers: bearerAuthHeaders('session') },
      });
      return {
        ok: true,
        json: async () => ({ users: [
          { userId: 'other', displayName: 'Wrong' },
          { userId: options.userId, displayName: 'Robert', avatarKey: 'avatar-key', avatarUrl: 'https://untrusted.example' },
        ] }),
      };
    });
    expect(await fetchPeerProfile({ ...options, authedFetch })).toEqual({
      displayName: 'Robert', avatarKey: 'avatar-key',
    });
  });

  test.each([401, 403, 500])('returns no profile for HTTP %s', async status => {
    const authedFetch = jest.fn(async () => ({ ok: false, status }));
    expect(await fetchPeerProfile({ ...options, authedFetch })).toBeNull();
  });

  test('returns no profile for an absent exact match or network failure', async () => {
    const authedFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [{ userId: 'bob', displayName: 'Other Bob' }] }) })
      .mockRejectedValueOnce(new Error('offline'));
    expect(await fetchPeerProfile({ ...options, authedFetch })).toBeNull();
    expect(await fetchPeerProfile({ ...options, authedFetch })).toBeNull();
  });

  test('discards a response aborted during JSON parsing', async () => {
    const controller = new AbortController();
    const authedFetch = jest.fn(async () => ({
      ok: true, json: async () => {
        controller.abort();
        return { users: [{ userId: options.userId, displayName: 'Robert' }] };
      },
    }));
    expect(await fetchPeerProfile({ ...options, authedFetch, signal: controller.signal })).toBeNull();
  });

  test('reads self through profile because the directory excludes the authenticated user', async () => {
    const authedFetch = jest.fn(async makeRequest => {
      expect(makeRequest('session').url).toBe('https://server.example/profile');
      return { ok: true, json: async () => ({ userId: options.userId, displayName: 'My Name', avatarKey: null }) };
    });
    expect(await fetchPeerProfile({
      ...options, currentUserId: options.userId, authedFetch,
    })).toEqual({ displayName: 'My Name', avatarKey: null });
  });

  test('passes the caller AbortSignal to the authenticated request', async () => {
    const controller = new AbortController();
    const authedFetch = jest.fn(async makeRequest => {
      expect(makeRequest('session').options.signal).toBe(controller.signal);
      controller.abort();
      return { ok: true, json: jest.fn() };
    });
    expect(await fetchPeerProfile({ ...options, authedFetch, signal: controller.signal })).toBeNull();
  });

  test('already-aborted requests and absent transport do not start a lookup', async () => {
    const controller = new AbortController();
    controller.abort();
    const authedFetch = jest.fn();
    expect(await fetchPeerProfile({ ...options, authedFetch, signal: controller.signal })).toBeNull();
    expect(authedFetch).not.toHaveBeenCalled();
    expect(await fetchPeerProfile({ ...options, authedFetch: null })).toBeNull();
  });
});
