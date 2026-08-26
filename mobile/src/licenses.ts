/**
 * The open-source libraries this app ships, and the licence each is under.
 *
 * Every one of these licences requires the notice to travel with the binary,
 * which an app with no About screen was not doing. The list is checked in
 * rather than generated at runtime because `package.json` is not part of the
 * shipped bundle's public surface and walking `node_modules` on device is not
 * possible; `__tests__/licenses.test.ts` fails the build if it drifts from the
 * declared runtime dependencies, so "checked in" cannot mean "stale".
 *
 * Development-only dependencies are deliberately absent: they are not
 * distributed with the app, so their notices do not travel with it.
 */

export type ThirdPartyLicense = {
  /** Package name, exactly as it appears in `package.json` dependencies. */
  name: string;
  /** SPDX identifier as declared by the package itself. */
  license: string;
};

export const THIRD_PARTY_LICENSES: ThirdPartyLicense[] = [
  { name: '@react-native-community/netinfo', license: 'MIT' },
  { name: '@react-native-documents/picker', license: 'MIT' },
  { name: '@react-native-firebase/app', license: 'Apache-2.0' },
  { name: '@react-native-firebase/auth', license: 'Apache-2.0' },
  { name: '@react-native-firebase/messaging', license: 'Apache-2.0' },
  { name: '@react-native-google-signin/google-signin', license: 'MIT' },
  { name: '@react-navigation/bottom-tabs', license: 'MIT' },
  { name: '@react-navigation/native', license: 'MIT' },
  { name: '@react-navigation/native-stack', license: 'MIT' },
  { name: 'react', license: 'MIT' },
  { name: 'react-native', license: 'MIT' },
  { name: 'react-native-callkeep', license: 'ISC' },
  { name: 'react-native-fs', license: 'MIT' },
  { name: 'react-native-gesture-handler', license: 'MIT' },
  { name: 'react-native-image-picker', license: 'MIT' },
  { name: 'react-native-incall-manager', license: 'ISC' },
  { name: 'react-native-nitro-modules', license: 'MIT' },
  { name: 'react-native-nitro-sound', license: 'MIT' },
  { name: 'react-native-reanimated', license: 'MIT' },
  { name: 'react-native-safe-area-context', license: 'MIT' },
  { name: 'react-native-screens', license: 'MIT' },
  { name: 'react-native-vector-icons', license: 'MIT' },
  { name: 'react-native-video', license: 'MIT' },
  { name: 'react-native-webrtc', license: 'MIT' },
  { name: 'react-native-worklets', license: 'MIT' },
  { name: 'socket.io-client', license: 'MIT' },
];

/** Distinct licences in use, for the one-line summary above the list. */
export function summarizeLicenses(licenses: ThirdPartyLicense[] = THIRD_PARTY_LICENSES): string {
  const distinct = Array.from(new Set(licenses.map(entry => entry.license))).sort();
  return `${licenses.length} libraries · ${distinct.join(', ')}`;
}
