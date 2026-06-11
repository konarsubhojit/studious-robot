# Mobile (React Native CLI)

Bare React Native app (React Native CLI) for the studious-robot project.

## Requirements
- Node.js (see repo root `.nvmrc`)
- JDK 17+ and the Android SDK (Android Studio recommended) for Android builds
- Xcode + CocoaPods for iOS builds (macOS only)

## Setup
```bash
cd mobile
npm install
```

Optional environment variables for signaling and TURN (inlined at build time via
`babel-plugin-transform-inline-environment-variables`):

```bash
export SIGNALING_URL=http://<YOUR_SIGNALING_HOST>:4173
export ROOM_ID=room-1
export TURN_USERNAME=<metered_turn_username>
export TURN_CREDENTIAL=<metered_turn_credential>
```

If TURN credentials are not provided, TURN support is disabled and only STUN is used.

## Run
```bash
npm start          # start the Metro bundler
npm run android    # build & launch on a connected Android device/emulator
npm run ios        # build & launch on an iOS simulator (macOS)
```

Open the app on Android and grant camera/microphone permissions to start local
preview and join a room. For device-to-device testing, launch two clients with
the same room ID. During a call, the remote video is shown as the primary view,
the local camera appears as picture-in-picture, and the Mute / Video controls
toggle local outgoing tracks in real time.

## Build a debug APK locally
```bash
cd android
./gradlew assembleDebug
# => android/app/build/outputs/apk/debug/app-debug.apk
```

## Other scripts
```bash
npm run lint       # eslint
npm test           # jest
```
