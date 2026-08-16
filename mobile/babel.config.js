module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'transform-inline-environment-variables',
      {
        include: [
          'SIGNALING_URL',
          'ROOM_ID',
          'TURN_USERNAME',
          'TURN_CREDENTIAL',
          'GOOGLE_WEB_CLIENT_ID',
        ],
      },
    ],
    'react-native-reanimated/plugin',
  ],
};
