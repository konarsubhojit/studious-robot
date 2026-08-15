module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'transform-inline-environment-variables',
      {
        include: ['SIGNALING_URL', 'ROOM_ID', 'TURN_USERNAME', 'TURN_CREDENTIAL'],
      },
    ],
    'react-native-reanimated/plugin',
  ],
};
