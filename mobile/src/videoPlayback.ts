import { logInfo, logWarn } from './appLogger';
import type { ComponentType } from 'react';

/**
 * Lazy access to `react-native-video`, following the same
 * optional-native-module pattern as `vectorIcons.tsx` / `voiceRecorder.ts`.
 *
 * The component is only required when a video is actually opened, so a build
 * where the native module is not linked (CI, or an older installed app) shows
 * the download fallback instead of crashing the conversation.
 */

let _videoCache: ComponentType<any> | null | undefined;

export function loadVideoComponent(): ComponentType<any> | null {
  if (_videoCache !== undefined) return _videoCache;
  try {
    const module = require('react-native-video');
    const component = module?.default ?? module?.Video ?? null;
    _videoCache = typeof component === 'function' || typeof component === 'object' ? component : null;
    if (_videoCache) {
      logInfo('[Media] video player module loaded');
    } else {
      logWarn('[Media] video player module exported no component');
    }
  } catch (error) {
    logWarn('[Media] video player module is not linked', { error });
    _videoCache = null;
  }
  return _videoCache ?? null;
}

/** Reset the cached module (tests only). */
export function _resetVideoComponentCache() {
  _videoCache = undefined;
}

/** Whether `mimeType` names a video this build knows how to play. */
export function isVideoMimeType(mimeType: unknown): boolean {
  return typeof mimeType === 'string' && mimeType.trim().toLowerCase().startsWith('video/');
}

/** Whether `mimeType` names audio that can go through the inline audio player. */
export function isAudioMimeType(mimeType: unknown): boolean {
  return typeof mimeType === 'string' && mimeType.trim().toLowerCase().startsWith('audio/');
}
