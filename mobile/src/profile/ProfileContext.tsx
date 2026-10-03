import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { resolveDisplayName } from '../../../shared/identity';
import { createProfileStore } from './profileStore';
import type { ReactNode } from 'react';
import type { PeerProfile } from '../types/directory';
import type { ProfileStore, ProfileTransport, ResolvedPeerProfile } from './profileStore';

const ProfileContext = createContext<ProfileStore | null>(null);
const emptySubscribe = () => () => {};

/** Separate data boundary allows focused tests without native call dependencies. */
export function ProfileDataProvider({
  children, transport, blockedUsers = [],
}: { children: ReactNode; transport: ProfileTransport; blockedUsers?: string[] }) {
  const { userId, signalingUrl, authedFetch, searchUsers } = transport;
  const store = useMemo(() => createProfileStore({
    userId, signalingUrl, authedFetch, searchUsers,
  }), [userId, signalingUrl, authedFetch, searchUsers]);
  useEffect(() => {
    const release = store.retain();
    void store.loadDirectory();
    return release;
  }, [store]);
  useEffect(() => { store.setBlocked(blockedUsers); }, [blockedUsers, store]);
  useEffect(() => {
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && previousState !== 'active') void store.refreshProfiles();
      previousState = state;
    });
    return () => subscription.remove();
  }, [store]);
  return <ProfileContext.Provider value={store}>{children}</ProfileContext.Provider>;
}

/** Safe outside the provider: tests and placeholders still display a resolved name. */
export function usePeerProfile(userId: string, suppliedProfile?: PeerProfile) {
  const store = useContext(ProfileContext);
  const fallback = useMemo<ResolvedPeerProfile>(() => ({
    displayName: suppliedProfile?.displayName,
    avatarKey: suppliedProfile?.avatarKey,
    userId,
    name: resolveDisplayName(userId, suppliedProfile?.displayName),
  }), [userId, suppliedProfile]);
  const getSnapshot = useCallback(() => store?.get(userId) ?? fallback, [store, userId, fallback]);
  const profile = useSyncExternalStore(store?.subscribe ?? emptySubscribe, getSnapshot, getSnapshot);
  const displayName = suppliedProfile?.displayName;
  const avatarKey = suppliedProfile?.avatarKey;
  useEffect(() => { store?.seed(userId, { displayName, avatarKey }); }, [store, userId, displayName, avatarKey]);
  useEffect(() => store?.watch(userId), [store, userId]);
  useEffect(() => {
    if (userId) {
      void store?.ensureProfile(userId);
      void store?.ensureAvatar(userId);
    }
  }, [store, userId, profile]);
  return profile;
}
