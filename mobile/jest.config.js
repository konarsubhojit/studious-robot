module.exports = {
  preset: '@react-native/jest-preset',
  // `shared/` (the wire contracts used by both apps) lives outside this
  // project, so its Babel output must still resolve helpers/dependencies from
  // this app's node_modules.
  modulePaths: ['<rootDir>/node_modules'],
  // React Navigation (and react-native-screens) ship untranspiled ES modules,
  // so they must go through babel-jest like react-native itself instead of
  // being skipped as ordinary node_modules.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens)/)',
  ],
};
