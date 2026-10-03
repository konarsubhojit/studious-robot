import { useCallSelector } from '../call/CallProvider';
import { ProfileDataProvider } from './ProfileContext';
import type { ReactNode } from 'react';
import type { CallContextValue } from '../call/CallProvider';

export { usePeerProfile } from './ProfileContext';

const selectProfileScope = ({ callFlow }: CallContextValue) => ({
  userId: callFlow.isRegistered ? callFlow.userId : '',
  signalingUrl: callFlow.signalingUrl,
  authedFetch: callFlow.authedFetch,
  searchUsers: callFlow.searchUsers,
  blockedUsers: callFlow.blockedUsers,
});

export default function ProfileProvider({ children }: { children: ReactNode }) {
  const { blockedUsers, ...transport } = useCallSelector(selectProfileScope);
  return (
    <ProfileDataProvider
      transport={transport}
      blockedUsers={blockedUsers}>
      {children}
    </ProfileDataProvider>
  );
}
