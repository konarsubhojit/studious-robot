import { resolveDisplayName } from '../../../shared/identity';
import { bearerAuthHeaders } from '../authHeaders';
import { fetchPeerProfile } from './fetchPeerProfile';
import type { ContactRow, PeerProfile } from '../types/directory';

export type ResolvedPeerProfile = PeerProfile & {
  userId: string;
  name: string;
  avatarUrl?: string;
};

export type ProfileTransport = {
  signalingUrl: string;
  userId: string;
  authedFetch: (request: (sessionId: string) => {
    url: string;
    options: { headers: Record<string, string> };
  }) => Promise<Response | null | undefined>;
  searchUsers: (query?: string, options?: { limit?: number; forceRefresh?: boolean }) => Promise<ContactRow[]>;
};

const REFRESH_SKEW_MS = 5_000;
const RETRY_MS = 60_000;
const MAX_EXACT_LOOKUPS = 2;

/** Account/server-local data; signed URLs are never persisted or supplied by callers. */
export function createProfileStore(transport: ProfileTransport) {
  const profiles = new Map<string, ResolvedPeerProfile>();
  const listeners = new Set<() => void>();
  const pending = new Map<string, Promise<void>>();
  const deadlines = new Map<string, number>();
  const blocked = new Set<string>();
  const accessVersions = new Map<string, number>();
  const knownProfiles = new Set<string>();
  const directoryIds = new Set<string>();
  const watchedIds = new Map<string, number>();
  const exactRequests = new Map<string, Promise<void>>();
  const exactRetryAt = new Map<string, number>();
  const exactQueue: (() => void)[] = [];
  let activeExactLookups = 0;
  let disposed = false;
  let retainCount = 0;
  let directoryLoadedAt = Number.NEGATIVE_INFINITY;
  let directoryRequest: Promise<void> | undefined;
  let refreshRequest: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => { if (!disposed) listeners.forEach(listener => listener()); };
  const get = (id: string): ResolvedPeerProfile => {
    let profile = profiles.get(id);
    if (!profile) {
      profile = { userId: id, name: resolveDisplayName(id) };
      profiles.set(id, profile);
    }
    if (profile.avatarUrl && (deadlines.get(id) ?? 0) <= Date.now()) {
      profile = { ...profile, avatarUrl: undefined };
      profiles.set(id, profile);
      deadlines.delete(id);
    }
    return profile;
  };
  const seed = (id: string, supplied?: PeerProfile) => {
    if (disposed || !id || !supplied) return;
    if (supplied.displayName !== undefined || supplied.avatarKey !== undefined) knownProfiles.add(id);
    const previous = get(id);
    const next = {
      ...previous,
      ...(supplied.displayName !== undefined ? { displayName: supplied.displayName } : {}),
      ...(supplied.avatarKey !== undefined ? { avatarKey: supplied.avatarKey } : {}),
    };
    next.name = resolveDisplayName(id, next.displayName);
    if (next.displayName === previous.displayName && next.avatarKey === previous.avatarKey) return;
    if (next.avatarKey !== previous.avatarKey) {
      next.avatarUrl = undefined;
      deadlines.delete(id);
    }
    profiles.set(id, next);
    emit();
  };
  const request = async (path: string) => {
    const response = await transport.authedFetch(sessionId => ({
      url: `${transport.signalingUrl.replace(/\/$/, '')}${path}`,
      options: { headers: bearerAuthHeaders(sessionId) },
    }));
    return response?.ok ? response.json() : null;
  };
  const loadDirectory = (forceRefresh = false) => {
    if (disposed || !transport.userId || !transport.signalingUrl) return Promise.resolve();
    if (directoryRequest) return directoryRequest;
    if (!forceRefresh && Date.now() - directoryLoadedAt < RETRY_MS) return Promise.resolve();
    directoryLoadedAt = Date.now();
    // authedFetch establishes the session that searchUsers reads from its ref.
    // Running these in parallel can otherwise cache an empty pre-session directory.
    directoryRequest = request('/profile').then(profile => {
      if (profile && !disposed) seed(transport.userId, profile.profile ?? profile);
    }).catch(() => {}).then(async () => {
      if (disposed) return;
      const rows = await transport.searchUsers('', { limit: 100, ...(forceRefresh ? { forceRefresh } : {}) });
      if (!disposed) {
        directoryIds.clear();
        rows.forEach(row => { directoryIds.add(row.userId); seed(row.userId, row); });
      }
    }).catch(() => {}).finally(() => { directoryRequest = undefined; });
    return directoryRequest;
  };
  const drainExactQueue = () => {
    while ((disposed || activeExactLookups < MAX_EXACT_LOOKUPS) && exactQueue.length) {
      exactQueue.shift()?.();
    }
  };
  const ensureProfile = (id: string): Promise<void> => {
    if (disposed || !id || !transport.userId || blocked.has(id) || knownProfiles.has(id)) return Promise.resolve();
    if (id === transport.userId) return loadDirectory();
    const pendingRequest = exactRequests.get(id);
    if (pendingRequest) return pendingRequest;
    const operation = loadDirectory().then(async () => {
      if (disposed || blocked.has(id) || knownProfiles.has(id)
        || (exactRetryAt.get(id) ?? 0) > Date.now()) return;
      await new Promise<void>(resolve => {
        exactQueue.push(() => {
          if (disposed || blocked.has(id) || knownProfiles.has(id)) { resolve(); return; }
          activeExactLookups += 1;
          exactRetryAt.set(id, Date.now() + RETRY_MS);
          void fetchPeerProfile({
            userId: id,
            signalingUrl: transport.signalingUrl,
            authedFetch: transport.authedFetch,
          }).then(profile => {
            if (disposed || blocked.has(id)) return;
            if (profile) {
              seed(id, profile);
            } else {
              const previous = get(id);
              knownProfiles.delete(id);
              deadlines.delete(id);
              if (previous.avatarKey || previous.avatarUrl) {
                profiles.set(id, { ...previous, avatarKey: null, avatarUrl: undefined });
                emit();
              }
              schedule();
            }
          }).finally(() => {
            activeExactLookups -= 1;
            resolve();
            drainExactQueue();
          });
        });
        drainExactQueue();
      });
    }).finally(() => {
      exactRequests.delete(id);
      schedule();
    });
    exactRequests.set(id, operation);
    return operation;
  };
  const refreshProfiles = () => {
    if (disposed || !transport.userId) return Promise.resolve();
    if (refreshRequest) return refreshRequest;
    refreshRequest = (async () => {
      // A preceding cached/bootstrap read must finish before a forced fresh read.
      await directoryRequest;
      if (disposed) return;
      await loadDirectory(true);
      if (disposed) return;
      await Promise.all(Array.from(watchedIds.keys()).map(async id => {
        if (blocked.has(id)) return;
        const needsLookup = id !== transport.userId
          && (!directoryIds.has(id) || !knownProfiles.has(id));
        if (needsLookup) {
          await exactRequests.get(id);
          if (disposed || !watchedIds.has(id) || blocked.has(id)) return;
          knownProfiles.delete(id);
          exactRetryAt.delete(id);
          await ensureProfile(id);
        }
        if (disposed || !watchedIds.has(id) || blocked.has(id)) return;
        if (!get(id).avatarUrl) deadlines.delete(id);
        await ensureAvatar(id);
      }));
    })().finally(() => { refreshRequest = undefined; });
    return refreshRequest;
  };
  const canRetryExact = (id: string) => watchedIds.has(id)
    && !blocked.has(id) && !knownProfiles.has(id) && !exactRequests.has(id);
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    let nextDeadline = Number.POSITIVE_INFINITY;
    deadlines.forEach((deadline, id) => {
      if (watchedIds.has(id)) nextDeadline = Math.min(nextDeadline, deadline);
    });
    exactRetryAt.forEach((deadline, id) => {
      if (canRetryExact(id)) nextDeadline = Math.min(nextDeadline, deadline);
    });
    if (!Number.isFinite(nextDeadline)) return;
    timer = setTimeout(() => {
      const now = Date.now();
      deadlines.forEach((deadline, id) => {
        if (watchedIds.has(id) && deadline <= now) {
          deadlines.delete(id);
          const profile = profiles.get(id);
          if (profile) profiles.set(id, { ...profile, avatarUrl: undefined });
        }
      });
      exactRetryAt.forEach((deadline, id) => {
        if (canRetryExact(id) && deadline <= now) void ensureProfile(id);
      });
      emit();
      schedule();
    }, Math.max(1, nextDeadline - Date.now()));
  };
  const ensureAvatar = (id: string) => {
    if (disposed || !id || !transport.userId || blocked.has(id) || !get(id).avatarKey) return Promise.resolve();
    if ((deadlines.get(id) ?? 0) > Date.now()) return Promise.resolve();
    const existing = pending.get(id);
    if (existing) return existing;
    const key = get(id).avatarKey;
    const accessVersion = accessVersions.get(id) ?? 0;
    const operation = request(`/avatar/download?userId=${encodeURIComponent(id)}`).then(result => {
      if (disposed || blocked.has(id) || get(id).avatarKey !== key
        || (accessVersions.get(id) ?? 0) !== accessVersion) return;
      const expiresAt = typeof result?.expiresAt === 'number'
        ? result.expiresAt : Date.parse(result?.expiresAt ?? '');
      const valid = result?.userId === id
        && typeof result?.avatarKey === 'string' && result.avatarKey.trim().length > 0
        && typeof result?.downloadUrl === 'string'
        && /^https?:\/\//.test(result.downloadUrl)
        && expiresAt - REFRESH_SKEW_MS > Date.now();
      profiles.set(id, {
        ...get(id),
        ...(valid ? { avatarKey: result.avatarKey } : {}),
        avatarUrl: valid ? result.downloadUrl : undefined,
      });
      deadlines.set(id, valid ? expiresAt - REFRESH_SKEW_MS : Date.now() + RETRY_MS);
    }).catch(() => {
      if (disposed || blocked.has(id) || get(id).avatarKey !== key
        || (accessVersions.get(id) ?? 0) !== accessVersion) return;
      deadlines.set(id, Date.now() + RETRY_MS);
    }).finally(() => {
      pending.delete(id);
      if (!disposed) {
        emit();
        schedule();
        if (get(id).avatarKey !== key || (accessVersions.get(id) ?? 0) !== accessVersion) {
          void ensureAvatar(id);
        }
      }
    });
    pending.set(id, operation);
    return operation;
  };
  const dispose = () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    listeners.clear();
    watchedIds.clear();
    drainExactQueue();
  };
  return {
    get,
    seed,
    loadDirectory,
    ensureProfile,
    refreshProfiles,
    ensureAvatar,
    watch(id: string) {
      if (id) watchedIds.set(id, (watchedIds.get(id) ?? 0) + 1);
      schedule();
      return () => {
        const count = watchedIds.get(id) ?? 0;
        if (count <= 1) watchedIds.delete(id);
        else watchedIds.set(id, count - 1);
        schedule();
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setBlocked(ids: string[]) {
      const next = new Set(ids);
      let changed = false;
      profiles.forEach((profile, id) => {
        if (next.has(id) && profile.avatarUrl) {
          profiles.set(id, { ...profile, avatarUrl: undefined });
          changed = true;
        }
        if (next.has(id) !== blocked.has(id)) {
          deadlines.delete(id);
          accessVersions.set(id, (accessVersions.get(id) ?? 0) + 1);
          profiles.set(id, { ...get(id) });
          changed = true;
        }
      });
      blocked.clear();
      next.forEach(id => blocked.add(id));
      if (changed) emit();
      schedule();
    },
    retain() {
      retainCount += 1;
      return () => {
        retainCount -= 1;
        // Strict Mode replays effects synchronously; don't dispose its reused store.
        void Promise.resolve().then(() => { if (!retainCount) dispose(); });
      };
    },
    dispose,
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;
