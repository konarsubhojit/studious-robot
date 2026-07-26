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
the same room ID. While in the lobby you can set signaling/room values and
export logs. The lobby now shows the local camera preview as soon as media
access succeeds, and any RTC/native video render failure degrades to an inline
message instead of crashing to a blank screen. Once the call starts the app
switches to a dedicated in-call UI with:

- a draggable picture-in-picture (PiP) self-view that can be tapped to swap
  local/remote focus,
- call timer + connection quality signal bars (from periodic WebRTC stats),
- reconnect banner with a manual **Retry** action,
- in-call controls for mute, video, speaker/earpiece route, camera switch, and
  screen sharing.

## Audio routing

During a call the audio output route can be switched between the loudspeaker,
earpiece, and any connected Bluetooth device using the **Speaker / Earpiece**
toggle button in the in-call controls row.

The app uses `react-native-incall-manager` (`src/audioRouting.js`) to:

- **Activate the in-call audio focus** so that media volume controls and audio
  interruption behaviour work correctly.
- **Manage the proximity sensor** — when `media: 'video'` is passed to
  `InCallManager.start`, the library automatically dims the screen and switches
  to earpiece when the handset is held to the ear.
- **Keep the screen on** throughout the call so the controls remain accessible.
- **Switch routes on demand** via `setForceSpeakerphoneOn` /
  `setSpeakerphoneOn`. When a Bluetooth device is paired, choosing *Earpiece*
  will route through Bluetooth rather than the physical earpiece.

Toggling the route does **not** restart the audio session — the speaker
preference is applied in a dedicated effect that runs independently of the
session lifecycle.  This means microphone muting continues to work correctly
regardless of which output route is active.

## Screen sharing

The in-call control deck has a **screen share** button (`src/screenShare.js` +
`src/hooks/useScreenShare.js`). Tapping it requests the OS screen-capture
consent dialog through `getDisplayMedia` and, once granted:

- replaces the outgoing camera track with the screen track using
  `RTCRtpSender.replaceTrack` and performs a renegotiation round-trip so the
  remote peer properly re-initialises its video decoder for the new source;
- keeps the camera track alive but disabled, so the previous video source is
  restored instantly when sharing stops (also when the user stops the share
  from the OS overlay);
- disables the camera on/off and camera-switch buttons while sharing.

### Optional screen audio

Next to the share button is a **screen audio** toggle, equivalent to the MS
Teams *Include computer sound* option. It applies to the next share and cannot
be changed mid-share (that would churn the SDP).

When enabled, the capture requests `{ video: true, audio: true }`. If the
platform returns an audio track it is added as an **additional** sender — the
microphone track is untouched, so mute keeps working independently. Stopping
the share removes the sender and renegotiates once more.

Screen audio is strictly best-effort: many Android builds and iOS (without a
broadcast upload extension) only return a video track. In that case the share
still starts and the UI shows a non-fatal *"screen audio unavailable on this
device"* warning. A denied/cancelled consent dialog is reported as a plain
status message and leaves the call untouched.

## ICE restart and reconnection

WebRTC ICE connections can break when the device switches networks (e.g. Wi-Fi
→ mobile data) or when the device wakes from sleep.  Two mechanisms are in
place to restore connectivity without ending the call:

1. **Socket.IO reconnect → ICE restart**: when the signaling socket reconnects
   after a transient drop, the app re-emits `join-room` and — if it was the
   original offerer — immediately sends a new WebRTC offer with
   `{ iceRestart: true }`.  This re-negotiates the ICE candidates over the new
   network path while keeping the existing media tracks and call UI intact.

2. **Automatic ICE failure recovery**: an `oniceconnectionstatechange` handler
   on the `RTCPeerConnection` watches for the `failed` state.  If reached, and
   the offerer role is held and the socket is still connected, an ICE-restart
   offer is sent automatically — without any user action required.

> **Note:** Only the side that created the original SDP offer sends ICE-restart
> offers.  The answerer simply processes the new offer normally.  This
> convention avoids signaling races if both peers detect failure simultaneously.



To keep calls alive when the app is backgrounded, Android uses a lightweight
foreground service and the system Picture-in-Picture (PiP) window:

- **Foreground service** — when a call connects, a foreground service with an
  ongoing notification ("Call in progress") is started so the OS keeps the
  process and media capture alive while the app is in the background. It is
  stopped when you leave the room.
- **Picture-in-Picture** — pressing Home (or otherwise leaving the app) while a
  call is active shrinks the call into a small floating PiP window so you can
  keep watching while using other apps. PiP requires Android 8.0 (API 26) or
  newer.
- **Reconnection** — Socket.IO uses a short bounded reconnection policy and
  re-joins the room automatically after a transient drop. While reconnecting,
  the UI shows a "Reconnecting…" indicator instead of ending the call.

These features rely on the following permissions declared in
`android/app/src/main/AndroidManifest.xml`:

- `INTERNET` — connect to the signaling server and TURN/STUN services.
- `CAMERA`, `RECORD_AUDIO` — capture the local video/audio tracks for
  `react-native-webrtc`.
- `MODIFY_AUDIO_SETTINGS` — let `react-native-webrtc` and
  `react-native-incall-manager` control in-call audio routing and focus.
- `WAKE_LOCK` — allow `react-native-incall-manager` to keep the device awake
  during an active call.
- `ACCESS_NETWORK_STATE` — allow `react-native-webrtc` to query Android network
  connectivity during ICE gathering without crashing native WebRTC threads.
- `BLUETOOTH` (Android 11 and older) and `BLUETOOTH_CONNECT` (Android 12+) —
  enable Bluetooth call-audio routing. `BLUETOOTH_CONNECT` is requested at
  runtime; if denied, the call stays on speaker/earpiece instead of crashing.
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CAMERA`,
  `FOREGROUND_SERVICE_MICROPHONE` — run the call foreground service with
  camera/microphone access.
- `FOREGROUND_SERVICE_MEDIA_PROJECTION` — required on Android 14+ so
  `react-native-webrtc` can run screen capture in a media-projection
  foreground service.
- `POST_NOTIFICATIONS` — show the ongoing call notification on Android 13 (API
  33) and newer.
- `VIBRATE` — allow `react-native-incall-manager` to vibrate the device on
  incoming calls.

The Android APK workflow now inspects the assembled debug APK with `aapt dump
permissions` and fails CI if any required call permission is missing from the
final packaged manifest.

The `MainActivity` also declares `android:supportsPictureInPicture="true"` and
`android:resizeableActivity="true"` to enable PiP.

> **Note:** Some device manufacturers apply aggressive battery optimizations that
> may still stop background processes. The foreground service and PiP mitigate
> the most common cases. PiP handling here targets Android only.

## Adaptive camera lighting

Adaptive camera lighting is now controlled from the in-app **Settings** menu and
is **disabled by default** for better stability on devices with strict camera
constraint handling.

When enabled, every few seconds the app estimates scene brightness from the live
video track and applies lighting-adjusted camera controls:

- **Low light** — lowers frame rate (to allow longer exposure), raises exposure
  compensation and brightness.
- **Bright light** — keeps a smooth frame rate and lowers exposure compensation.

Controls are applied as best-effort `advanced` constraints, so unsupported values
are ignored rather than interrupting the camera.

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
