import { Platform } from 'react-native';
import appConfig from '../app.json';
import packageJson from '../package.json';
import { getApplicationId, getReactNativeVersion } from './diagnostics';

/**
 * What the app can truthfully say about itself.
 *
 * Settings had no About group at all, so the version a user would quote in a
 * bug report was unobtainable from inside the app — and the same facts were
 * already being assembled, once, for the diagnostic log export
 * (`buildExportHeader`). Both read from here now, so a support conversation and
 * an exported log cannot disagree about which build is running.
 *
 * The version is the JavaScript bundle's (`package.json`), which is the only
 * one this codebase owns: the store-facing `versionName` / `MARKETING_VERSION`
 * are set per platform in the native projects, and are not readable from JS
 * without adding a native module for it.
 */

/** Version of the JavaScript bundle. */
export const APP_VERSION: string = packageJson.version;

/** Name as shown on the home screen. */
export const APP_DISPLAY_NAME: string =
  appConfig?.displayName || appConfig?.name || 'WeTalk';

export type AppInfo = {
  version: string;
  displayName: string;
  /** Android `applicationId` / iOS bundle identifier, or `'unknown'`. */
  applicationId: string;
  platform: string;
  osVersion: string;
  reactNativeVersion: string;
};

/**
 * Read at call time rather than at module load: the native constants these
 * come from are not guaranteed to exist while the bridge is still starting.
 */
export function getAppInfo(): AppInfo {
  return {
    version: APP_VERSION,
    displayName: APP_DISPLAY_NAME,
    applicationId: getApplicationId(),
    platform: Platform.OS,
    osVersion: String(Platform.Version ?? 'unknown'),
    reactNativeVersion: getReactNativeVersion(),
  };
}

/**
 * One line naming the platform this build is running on, for the row under
 * the version.
 */
export function describePlatform(info: AppInfo = getAppInfo()): string {
  const platformLabel = info.platform === 'ios' ? 'iOS' : info.platform === 'android' ? 'Android' : info.platform;
  return `${platformLabel} ${info.osVersion} · React Native ${info.reactNativeVersion}`;
}
