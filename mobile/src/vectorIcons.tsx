import type MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

/**
 * Lazy-loaded wrapper for react-native-vector-icons/MaterialCommunityIcons.
 *
 * Follows the same optional-native-module pattern used by Firebase messaging
 * and react-native-callkeep: the module is required at call-time via a
 * try/catch so the app boots even when the native fonts have not been linked
 * (e.g. in CI or fresh checkouts before `npm install`).
 *
 * Usage:
 *   import { loadVectorIcons } from './vectorIcons';
 *   const MCIcon = loadVectorIcons();          // null when unavailable
 *   if (MCIcon) { return <MCIcon name="phone" size={24} color="#fff" />; }
 *
 * Icon names: https://pictogrammers.com/library/mdi/
 */

export type MaterialCommunityIcons = typeof MaterialCommunityIcons;

let _cache: MaterialCommunityIcons | null | undefined;

/**
 * Return the MaterialCommunityIcons component, or `null` when the native
 * module / fonts are not yet installed.
 */
export function loadVectorIcons(): MaterialCommunityIcons | null {
  if (_cache !== undefined) return _cache;
  try {
    _cache = require('react-native-vector-icons/MaterialCommunityIcons').default;
  } catch {
    _cache = null;
  }
  return _cache ?? null;
}

/** Reset the cached icon module (for testing only). */
export function _resetVectorIconsCache() {
  _cache = undefined;
}

/**
 * Map of semantic icon names used throughout the app to their
 * MaterialCommunityIcons glyph names and emoji fallbacks.
 */
export const ICONS: Record<string, { icon: string; emoji: string; }> = {
  settings: { icon: 'cog', emoji: '⚙️' },
  callRedial: { icon: 'phone-forward', emoji: '📞' },
  callIncoming: { icon: 'phone-incoming', emoji: '↓' },
  callMissed: { icon: 'phone-missed', emoji: '↘' },
  callOutgoing: { icon: 'phone-outgoing', emoji: '↑' },
  callEnd: { icon: 'phone-hangup', emoji: '📵' },
  callAccept: { icon: 'phone', emoji: '📞' },
  micOn: { icon: 'microphone', emoji: '🎙️' },
  micOff: { icon: 'microphone-off', emoji: '🔇' },
  videoOn: { icon: 'video', emoji: '📹' },
  videoOff: { icon: 'video-off', emoji: '📵' },
  cameraSwitch: { icon: 'camera-flip-outline', emoji: '🔄' },
  speaker: { icon: 'volume-high', emoji: '🔊' },
  screenShare: { icon: 'monitor-share', emoji: '🖥️' },
  screenShareOff: { icon: 'monitor-off', emoji: '🚫' },
  screenAudioOn: { icon: 'volume-source', emoji: '🔉' },
  screenAudioOff: { icon: 'volume-mute', emoji: '🔕' },
  speakerOff: { icon: 'volume-off', emoji: '🔈' },
  presenceOnline: { icon: 'circle', emoji: '●' },
  presenceOffline: { icon: 'circle-outline', emoji: '○' },
  dismiss: { icon: 'close', emoji: '✕' },
  chatAudioCall: { icon: 'phone', emoji: '📞' },
  chatVideoCall: { icon: 'video', emoji: '📹' },
  minimize: { icon: 'chevron-down', emoji: '⌄' },
  stopShare: { icon: 'monitor-off', emoji: '🚫' },
  tabChats: { icon: 'chat-outline', emoji: '💬' },
  tabChatsActive: { icon: 'chat', emoji: '💬' },
  tabCalls: { icon: 'phone-outline', emoji: '📞' },
  tabCallsActive: { icon: 'phone', emoji: '📞' },
  tabSettings: { icon: 'cog-outline', emoji: '⚙️' },
  tabSettingsActive: { icon: 'cog', emoji: '⚙️' },
  settingsUsername: { icon: 'account-outline', emoji: '👤' },
  settingsServer: { icon: 'server-network', emoji: '🌐' },
  settingsRecovery: { icon: 'key-variant', emoji: '🔑' },
  settingsAppearance: { icon: 'theme-light-dark', emoji: '🌗' },
  settingsDeveloper: { icon: 'code-tags', emoji: '🛠️' },
  settingsAccountSection: { icon: 'shield-account-outline', emoji: '🧾' },
  attachmentAttach: { icon: 'paperclip', emoji: '📎' },
  attachmentMic: { icon: 'microphone', emoji: '🎤' },
  attachmentMicStop: { icon: 'stop-circle-outline', emoji: '⏹️' },
  attachmentDownload: { icon: 'download', emoji: '⬇️' },
  mediaPlay: { icon: 'play', emoji: '▶️' },
  mediaPause: { icon: 'pause', emoji: '⏸️' },
  mediaFullscreen: { icon: 'fullscreen', emoji: '⛶' },
};
