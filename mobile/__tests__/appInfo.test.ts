import { Platform } from 'react-native';
import { APP_DISPLAY_NAME, APP_VERSION, describePlatform, getAppInfo } from '../src/appInfo';

const packageJson = require('../package.json');
const appConfig = require('../app.json');

describe('appInfo', () => {
  test('reports the JavaScript bundle version, the one this codebase owns', () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(APP_DISPLAY_NAME).toBe(appConfig.displayName ?? appConfig.name);
  });

  test('assembles the facts a bug report needs', () => {
    const info = getAppInfo();

    expect(info.version).toBe(packageJson.version);
    expect(info.platform).toBe(Platform.OS);
    expect(typeof info.applicationId).toBe('string');
    expect(typeof info.reactNativeVersion).toBe('string');
  });

  test('names the platform in the form a person reads', () => {
    expect(
      describePlatform({
        version: '0.1.0',
        displayName: 'WeTalk',
        applicationId: 'com.example',
        platform: 'android',
        osVersion: '34',
        reactNativeVersion: '0.81.0',
      }),
    ).toBe('Android 34 · React Native 0.81.0');

    expect(
      describePlatform({
        version: '0.1.0',
        displayName: 'WeTalk',
        applicationId: 'com.example',
        platform: 'ios',
        osVersion: '17.4',
        reactNativeVersion: '0.81.0',
      }),
    ).toBe('iOS 17.4 · React Native 0.81.0');
  });
});
