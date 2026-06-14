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
export logs; once the call starts the app switches to a dedicated in-call UI
with:

- a draggable floating self-view thumbnail that can be tapped to swap
  local/remote focus,
- call timer + connection quality signal bars (from periodic WebRTC stats),
- reconnect banner with a manual **Retry** action,
- in-call controls for mute, video, speaker/earpiece route, and camera switch.

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



### Foreground-only calls

Calls currently run **only while the app is in the foreground**. The Android
foreground call service and system Picture-in-Picture (PiP) window that
previously kept a call alive in the background have been **intentionally
removed** to avoid Android 14 foreground-service crash risk and Play Store
policy overhead. Background-call support may return later as a deliberate,
audio-only feature.

- **Reconnection** — Socket.IO uses a short bounded reconnection policy and
  re-joins the room automatically after a transient drop. While reconnecting,
  the UI shows a "Reconnecting…" indicator instead of ending the call.

The app declares only the permissions the call itself needs in
`android/app/src/main/AndroidManifest.xml`: `CAMERA`, `RECORD_AUDIO`,
`MODIFY_AUDIO_SETTINGS`, and `INTERNET`. The previous
`FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_CAMERA`/`FOREGROUND_SERVICE_MICROPHONE`
and `POST_NOTIFICATIONS` permissions, the `CallForegroundService` service entry,
and the `supportsPictureInPicture`/`resizeableActivity` activity attributes have
been removed.

> **Note:** Because there is no foreground service, sending the app to the
> background (Home, app switch, screen lock) will suspend the call. Keep the app
> in the foreground for the duration of a call.

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

The exported file includes app/runtime details (platform, OS version,
`react-native` / `react-native-webrtc` versions, New Architecture flag, current
connection/ICE/signaling states, log level, signaling URL, room ID, call ID,
call/socket state, and whether TURN was configured in the build) and a detailed,
time-ordered trace of app-side signaling/WebRTC events. Sensitive fields such as
TURN credentials, passwords, tokens, authorization values, and other secrets are
redacted or intentionally not logged. Full SDP bodies are never logged — only
`sdp.type` and length.

### Reading an exported log

Every log line is prefixed with a stable, greppable **stage tag** so you can
follow a call end-to-end:

- `[lifecycle]` — app mount/unmount, button presses, export.
- `[permissions]` / `[media]` — `getUserMedia`, camera resolution/fps,
  mute/video/camera-switch.
- `[signaling]` — Socket.IO connect/transport/disconnect and every signaling
  event (`join-room`, `peer-joined`, `offer`, `answer`, `ice-candidate`, …) with
  a `send`/`recv` direction.
- `[webrtc]` — `createOffer`/`createAnswer`/`setLocalDescription`/
  `setRemoteDescription` (each with a `durationMs`), peer-connection and track
  setup.
- `[ice]` — ICE gathering/connection states and the **selected candidate pair**.
- `[stats]` — periodic media-flow stats (RTT, packet loss, bitrate,
  `bytesReceived` growth). These are `debug`-level.
- `[audio]` — in-call audio session and speaker/earpiece route changes.
- `[teardown]` — leaving the room, closing the peer connection, stopping tracks.

Each call gets a short **`callId`** that is attached to all of its
signaling/WebRTC/ICE log lines, so you can `grep` a single call out of a busy
log.

#### Was TURN/relay used?

- Check the header line `turnConfigured: true|false` to see whether the build had
  TURN credentials at all.
- Search for `[ice] selected pair` — it logs the active pair, e.g.
  `{ local: 'relay', remote: 'srflx', protocol: 'udp', usesRelay: true }`. A
  `local`/`remote` type of `relay` (and `usesRelay: true`) means media is going
  **through TURN**; `host`/`srflx` means a direct path.
- A one-time `[ice] connection established` line is logged the first time the
  call reaches `connected`, summarizing the chosen candidate types and relay use.

#### Log level

The default log level is `info`. High-signal lifecycle/signaling/ICE-summary
lines are `info`; noisy per-candidate and per-stats-tick lines are `debug`. Set
the `LOG_LEVEL` build env var (e.g. `debug`) to include the debug lines.

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
