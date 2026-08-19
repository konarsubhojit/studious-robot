module.exports = {
  preset: '@react-native/jest-preset',
  // React Navigation (and react-native-screens) ship untranspiled ES modules,
  // so they must go through babel-jest like react-native itself instead of
  // being skipped as ordinary node_modules.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens)/)',
  ],
};
