import RNFS from 'react-native-fs';
import { findCachedAttachment, rememberCachedAttachment } from './attachmentCache';

/** Resolve an avatar to its app-owned cache file, fetching it when necessary. */
export async function cacheAvatarImage({
  avatarKey,
  downloadUrl,
  isCurrent,
}: {
  avatarKey?: string | null;
  downloadUrl?: string | null;
  isCurrent?: () => boolean;
}): Promise<string | null> {
  if (!avatarKey) return null;
  const cached = await findCachedAttachment({ cacheKey: avatarKey });
  if (cached) return cached.path;
  if (!downloadUrl || !/^https?:\/\//i.test(downloadUrl)) return null;

  const directory = RNFS?.CachesDirectoryPath || RNFS?.DocumentDirectoryPath;
  if (!directory || typeof RNFS?.downloadFile !== 'function') return null;
  const temporaryPath = `${directory}/avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`;
  try {
    const job = RNFS.downloadFile({ fromUrl: downloadUrl, toFile: temporaryPath });
    const result = await job.promise;
    if (!result || result.statusCode < 200 || result.statusCode >= 300) return null;
    if (isCurrent && !isCurrent()) return null;
    const entry = await rememberCachedAttachment({
      cacheKey: avatarKey,
      sourcePath: temporaryPath,
    });
    return entry?.path ?? null;
  } catch {
    return null;
  } finally {
    if (typeof RNFS?.unlink === 'function') {
      await RNFS.unlink(temporaryPath).catch(() => {});
    }
  }
}
