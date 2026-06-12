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

## Export diagnostic logs

Use the **Export Logs** button in the app UI to save a diagnostic log file from
the installed app.

- Android: the app first tries the public **Downloads** folder.
- If public Downloads is unavailable on a device/OS version, the app falls back
  to app-specific storage and shows the saved path in the status text.
- iOS: logs are saved to the app documents directory path.

Log files are named:
`studious-robot-logs-YYYYMMDD-HHMMSS.txt`

The exported file includes app/runtime details (platform, OS version, signaling
URL, room ID, call/socket state) and detailed app-side signaling/WebRTC events.
Sensitive fields such as TURN credentials, passwords, tokens, authorization
values, and other secrets are redacted or intentionally not logged.

## Build a debug APK locally
```bash
cd android
./gradlew assembleDebug
# => android/app/build/outputs/apk/debug/app-debug.apk
```

> **Note:** The debug APK loads JavaScript from the Metro bundler at runtime.
> Installing it on a device without Metro running will produce an
> *"Unable to load script"* error. Use `assembleRelease` below for a
> self-contained APK.

## Build a release APK locally

The release build bundles the JavaScript at compile time — no Metro server
required. Set the desired env vars before running Gradle:

```bash
export SIGNALING_URL=https://<your-signaling-host>
export ROOM_ID=room-1
export TURN_USERNAME=<metered_turn_username>
export TURN_CREDENTIAL=<metered_turn_credential>

cd android
./gradlew assembleRelease
# => android/app/build/outputs/apk/release/app-release.apk
```

## Other scripts
```bash
npm run lint       # eslint
npm test           # jest
```
