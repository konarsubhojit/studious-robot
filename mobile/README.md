# Mobile (Expo)

React Native app scaffolded with Expo for the studious-robot project.

## Requirements
- Node.js (see repo root `.nvmrc`)
- Android device/emulator with an Expo dev build (required for `react-native-webrtc`)

## Setup
```bash
cd mobile
npm install
```

Optional environment variables for signaling and TURN:

```bash
export EXPO_PUBLIC_SIGNALING_URL=http://<YOUR_SIGNALING_HOST>:3001
export EXPO_PUBLIC_ROOM_ID=room-1
export EXPO_PUBLIC_TURN_USERNAME=<metered_turn_username>
export EXPO_PUBLIC_TURN_CREDENTIAL=<metered_turn_credential>
```

If TURN credentials are not provided, TURN support is disabled and only STUN is used.

## Run in Codespaces
```bash
npm start          # alias for `expo start`
# or explicitly for tunnel (recommended from Codespaces):
npx expo start --tunnel
```

Open the app on Android and grant camera/microphone permissions to start local
preview and join a room. For device-to-device testing, launch two clients with
the same room ID. During a call, the remote video is shown as the primary view,
the local camera appears as picture-in-picture, and the Mute / Video controls
toggle local outgoing tracks in real time.

## Other scripts
```bash
npm run android    # open on connected Android device/emulator
npm run ios        # open on iOS simulator (macOS)
npm run web        # open web preview
npm test           # jest (passes with no tests by default)
```
