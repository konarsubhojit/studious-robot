const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * `watchFolders` includes the repository's `shared/` package so the app can
 * import the signaling/API contracts that the server also uses; Metro only
 * resolves files under the project root unless they are watched explicitly.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '..', 'shared')],
  resolver: {
    // Modules required from `shared/` (e.g. Babel runtime helpers) resolve
    // against this app's node_modules, which is not an ancestor of that folder.
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
