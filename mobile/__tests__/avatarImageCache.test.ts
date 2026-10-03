jest.mock('../src/appLogger', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

import RNFS from 'react-native-fs';
import { cacheAvatarImage } from '../src/avatarImageCache';
import { resetAttachmentCacheState } from '../src/attachmentCache';

const avatarKey = 'avatars/alice/123e4567-e89b-12d3-a456-426614174000.jpg';

beforeEach(() => {
  (RNFS as unknown as { __reset: () => void }).__reset();
  resetAttachmentCacheState();
  jest.clearAllMocks();
  (RNFS.downloadFile as jest.Mock).mockImplementation(({ toFile }: { toFile: string }) => {
    void RNFS.writeFile(toFile, 'avatar-bytes', 'utf8');
    return { promise: Promise.resolve({ statusCode: 200 }) };
  });
});

test('caches fetched avatar bytes by avatarKey across signed URL changes', async () => {
  const first = await cacheAvatarImage({
    avatarKey,
    downloadUrl: 'https://media.example/avatar?signature=one',
  });
  const second = await cacheAvatarImage({
    avatarKey,
    downloadUrl: 'https://media.example/avatar?signature=two',
  });

  expect(first).toContain('/attachments/attachment-');
  expect(second).toBe(first);
  expect(RNFS.downloadFile).toHaveBeenCalledTimes(1);
});

test('does not cache a completed download after its avatar key becomes stale', async () => {
  const isCurrent = jest.fn(() => false);

  await expect(cacheAvatarImage({
    avatarKey,
    downloadUrl: 'https://media.example/avatar',
    isCurrent,
  })).resolves.toBeNull();

  expect(isCurrent).toHaveBeenCalled();
  expect(RNFS.copyFile).not.toHaveBeenCalled();
});
