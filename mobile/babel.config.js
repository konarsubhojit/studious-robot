module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'transform-inline-environment-variables',
      {
        include: [
          'SIGNALING_URL',
          'GROUP_TRANSPORT',
          'ROOM_ID',
          'TURN_USERNAME',
          'TURN_CREDENTIAL',
          'GOOGLE_WEB_CLIENT_ID',
          'SENTRY_DSN',
          'SENTRY_RELEASE',
          'SENTRY_DIST',
        ],
      },
    ],
    'react-native-reanimated/plugin',
  ],
};
