import { OFFLINE_ICON } from '../../connectivityUx';
import { Banner } from '../primitives';

export default function OutboxOfflineBanner({ offline, count, testID = 'chat-offline-notice' }: {
  offline: boolean; count: number; testID?: string;
}) {
  if (!offline || count < 1) return null;
  return <Banner icon={OFFLINE_ICON} tone="warning" testID={testID}
    message={`${count} ${count === 1 ? 'message' : 'messages'} will send when you're back online`} />;
}
