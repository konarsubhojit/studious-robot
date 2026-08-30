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

Optional environment variables for signaling and the deprecated static TURN
fallback (inlined at build time via `babel-plugin-transform-inline-environment-variables`):

```bash
export SIGNALING_URL=http://<YOUR_SIGNALING_HOST>:4173
export GOOGLE_WEB_CLIENT_ID=<firebase-web-oauth-client-id>
export ROOM_ID=room-1
export TURN_USERNAME=<legacy_turn_username>
export TURN_CREDENTIAL=<legacy_turn_credential>
```

## Authentication

The first-launch screen supports:

- email/password registration and sign-in through Firebase Authentication;
- Google Sign-In;
- Microsoft Sign-In through Firebase's `microsoft.com` provider.

Enable **Email/Password**, **Google**, and **Microsoft** under **Firebase
Console → Authentication → Sign-in method**. Google requires the Web OAuth
client ID in `GOOGLE_WEB_CLIENT_ID`; add Android SHA-1/SHA-256 fingerprints and
the iOS URL scheme from `GoogleService-Info.plist` as described in
[`FIREBASE_SETUP.md`](../docs/FIREBASE_SETUP.md). Microsoft also requires its Azure
client ID and secret in the Firebase provider configuration.

The app sends short-lived Firebase ID tokens to the signaling server. It does
not generate or persist recovery/verification codes.

Production calls fetch short-lived Cloudflare TURN credentials from the signaling
server using the authenticated session. Configure that server with
`CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` (and optionally
`CLOUDFLARE_TURN_TTL_SECONDS`, default 3600). This avoids baking relay
credentials into a public APK. `TURN_USERNAME` and `TURN_CREDENTIAL` remain
supported only as a fallback; without either path calls use STUN-only.

## Run

```bash
npm start          # start the Metro bundler
npm run android    # build & launch on a connected Android device/emulator
npm run ios        # build & launch on an iOS simulator (macOS)
```

Open the app on Android and grant camera/microphone permissions, then register
a username. For device-to-device testing, launch two clients and call one
another by user ID. Enabling **Developer mode** in Settings adds a diagnostics
panel (log export and media settings) to the lobby. Any RTC/native video render
failure degrades to an inline message instead of crashing to a blank screen.
Once the call starts the app
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

At call start (and whenever a device is connected or removed mid-call) the
route is chosen automatically in priority order **Bluetooth → wired headset →
earpiece → loudspeaker** (`applyPreferredAudioRoute`). The loudspeaker is only
used when nothing else is available or when the user selects it; an explicit
selection is remembered for the rest of the call and is never overridden by an
automatic re-evaluation. When `BLUETOOTH_CONNECT` is denied the denial is
logged and the next device in the list is used instead.

The app uses `react-native-incall-manager` (`src/audioRouting.ts`) to:

- **Activate the in-call audio focus** so that media volume controls and audio
  interruption behaviour work correctly.
- **Manage the proximity sensor** — when `media: 'video'` is passed to
  `InCallManager.start`, the library automatically dims the screen and switches
  to earpiece when the handset is held to the ear.
- **Keep the screen on** throughout the call so the controls remain accessible.
- **Switch routes on demand** via `chooseAudioRoute` (which also starts the
  Bluetooth SCO link — a connected device alone does not carry call audio) and
  `setForceSpeakerphoneOn` / `setSpeakerphoneOn` for the speaker toggle.

Toggling the route does **not** restart the audio session — the speaker
preference is applied in a dedicated effect that runs independently of the
session lifecycle. This means microphone muting continues to work correctly
regardless of which output route is active.

## Screen sharing

The in-call control deck has a **screen share** button (`src/screenShare.ts` +
`src/hooks/useScreenShare.ts`). Tapping it requests the OS screen-capture
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
Teams _Include computer sound_ option. It applies to the next share and cannot
be changed mid-share (that would churn the SDP).

When enabled, the capture requests `{ video: true, audio: true }`. If the
platform returns an audio track it is added as an **additional** sender — the
microphone track is untouched, so mute keeps working independently. Stopping
the share removes the sender and renegotiates once more.

Screen audio is strictly best-effort: many Android builds and iOS (without a
broadcast upload extension) only return a video track. In that case the share
still starts and the UI shows a non-fatal _"screen audio unavailable on this
device"_ warning. A denied/cancelled consent dialog is reported as a plain
status message and leaves the call untouched.

### Required native setup

`getDisplayMedia` happily resolves with a video track on both platforms even
when the OS capture pipeline is not wired up — the track then simply never
produces frames, so the **remote peer sees a blank/black screen** while the
sharer's UI looks perfectly fine. Both platforms therefore need explicit setup:

- **Android** — MediaProjection only delivers frames while a foreground service
  of type `mediaProjection` is running (mandatory from Android 14).
  `react-native-webrtc` bundles that service but keeps it **disabled by
  default**, so `MainApplication.onCreate` sets
  `WebRTCModuleOptions.getInstance().enableMediaProjectionService = true` before
  `loadReactNative`. The service posts a notification whose small icon is
  resolved by name, so `res/drawable/ic_notification.xml` must exist —
  `startForeground` fails without it and capture stays black.
- **iOS** — ReplayKit can only capture the screen from a **Broadcast Upload
  Extension**; the app process itself cannot. The extension and the host app
  must share an App Group, and the app's `Info.plist` must declare
  `RTCAppGroupIdentifier` (plus `RTCScreenSharingExtension` with the extension's
  bundle id). Until that extension target is added to
  `ios/StudiousRobot.xcodeproj`, `ScreenCaptureController.startCapture` returns
  immediately and the shared screen stays blank on the receiving side.

Because a frameless capture is indistinguishable from a healthy one locally,
`verifyScreenShareFrames` polls the peer connection's outbound RTP stats for a
few seconds after the share starts; a capture that never reports
`framesSent`/`framesEncoded` is stopped and surfaced as an error instead of
silently "succeeding".

## ICE restart and reconnection

WebRTC ICE connections can break when the device switches networks (e.g. Wi-Fi
→ mobile data) or when the device wakes from sleep. Three triggers start the
same recovery ladder, so a call survives a handoff without ending:

1. **Socket.IO reconnect → ICE restart**: when the signaling socket reconnects
   after a transient drop, the app re-emits `join-room` and sends a new WebRTC
   offer with `{ iceRestart: true }`. This re-negotiates the ICE candidates
   over the new network path while keeping the existing media tracks and call
   UI intact.

2. **Automatic ICE failure recovery**: an `oniceconnectionstatechange` handler
   on the `RTCPeerConnection` watches for the `failed` state, and starts the
   ladder as soon as it is reached — without any user action required.

3. **Proactive network-change recovery**: connectivity transitions are watched
   directly (`@react-native-community/netinfo`, loaded defensively so an
   unlinked build simply falls back to the two triggers above). A Wi-Fi →
   cellular handoff restarts ICE immediately, debounced by 800 ms, instead of
   waiting the several seconds ICE takes to move from `disconnected` to
   `failed` — that interval is audible as dead air.

**Either peer restarts.** Recovery used to be gated on the offerer role, which
meant a *callee* whose IP changed waited for an offer the caller had no reason
to send, and the call died after the grace period. Now whichever side detects
the problem sends the ICE-restart offer, and glare is prevented by a
deterministic tie-break: the peer with the lexicographically lower `userId`
restarts immediately, the other waits 1.5 s and only proceeds if the connection
has not recovered by then. The existing negotiation guard still serialises
offer/answer exchanges.

**The ladder is bounded and TURN-aware.** Each attempt re-fetches ICE servers
and insists on a relay — a handoff is exactly when TURN matters, since the new
path is far more likely to sit behind carrier-grade NAT. A TURN-less list is
logged at `error` and the credential fetch is retried once, but never blocks
the restart: degraded recovery beats none. A failed restart is retried up to
three times with a `0 / 1.5 s / 4 s` backoff, and the ladder is cleared the
moment ICE reports `connected`/`completed` or the call ends.

Media loss is still only reported to the server after `ICE_FAILURE_GRACE_MS`
(12 s), and that report is cancelled if any of the above recovers the call.
Every attempt logs its trigger (`ice-failure`, `socket-reconnect`,
`network-change`), attempt number and outcome, so a dropped call can be
diagnosed from an exported log alone.

If the server rejects the presented session mid-call (a restart wipes the
in-memory session table), the client mints a fresh session and reconnects,
retrying up to three times rather than ending the call.

To keep calls alive when the app is backgrounded, Android uses a lightweight
foreground service and the system Picture-in-Picture (PiP) window:

- **Foreground service** — when a call connects, a foreground service with an
  ongoing notification ("Call in progress") is started so the OS keeps the
  process and media capture alive while the app is in the background. It is
  stopped when you leave the room.
- **Picture-in-Picture** — pressing Home (or otherwise leaving the app) while a
  call is active shrinks the call into a small floating PiP window so you can
  keep watching while using other apps. PiP requires Android 8.0 (API 26) or
  newer. The window is requested by the activity itself — from
  `onUserLeaveHint()`, which fires while it is still resumed, plus
  `setAutoEnterEnabled` on Android 12+ (API 31) for the Back gesture. JS never
  asks for PiP on an `AppState` background transition: by then the activity has
  left the resumed state and Android refuses with
  `Activity must be resumed to enter picture-in-picture`. Ending a call closes
  the PiP window (`exitPictureInPictureMode`) and
  releases the local stream so no frozen frame is left on screen, and closing
  the PiP window ends the call — the activity reports every PiP transition to
  JS through `MainActivity.onPictureInPictureModeChanged`.
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
- `POST_NOTIFICATIONS` — show the ongoing call notification on Android 13 (API 33) and newer.
- `VIBRATE` — allow `react-native-incall-manager` to vibrate the device on
  incoming calls.
- `USE_FULL_SCREEN_INTENT` — required to post WeTalk's own branded,
  full-screen-intent incoming-call notification (`IncomingCallNotificationModule`),
  shown in response to `react-native-callkeep`'s self-managed `showIncomingCallUi`
  event; without it, a call arriving while the screen is locked never wakes to
  that screen. Android 14+ additionally requires the user to have granted this
  app special access — `IncomingCallNotificationModule` checks
  `NotificationManager.canUseFullScreenIntent()` and falls back to a plain (but
  still audible, high-importance-channel) heads-up notification when denied.

The Android APK workflow now inspects the assembled release APK with `aapt dump
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

## Theming (light & dark)

The design tokens in `src/theme.ts` ship two palettes — `palettes.light` and
`palettes.dark` — that expose exactly the same token names. `ThemeProvider`
(`src/ThemeProvider.tsx`, mounted in `App.tsx`) picks the palette from the OS
colour scheme via `useColorScheme()`, so flipping the device theme re-themes the
app immediately without a restart, and **Settings → Appearance** offers a
manual **System / Light / Dark** override that is persisted to
`wetalk-theme.json`.

Components read colours through the context instead of importing `colors`:

```js
import { useTheme, useThemedStyles } from '../ThemeContext';
import { spacing } from '../theme';

export default function Example() {
  const { colors } = useTheme();               // for inline/prop colours
  const styles = useThemedStyles(createStyles); // rebuilt on a theme switch
  return <View style={styles.card} />;
}

const createStyles = colors =>
  StyleSheet.create({
    card: { backgroundColor: colors.surface, padding: spacing.md },
  });
```

Every text/background pairing in both palettes meets WCAG AA (4.5:1), and
control borders clear the 3:1 non-text ratio; `__tests__/theme.test.ts` asserts
this. The video stage stays dark in both schemes so camera frames are never
letterboxed in white.

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
URL, call ID, call/socket state) and detailed app-side signaling/WebRTC events.
Sensitive fields such as TURN credentials, passwords, tokens, authorization
values, and other secrets are redacted or intentionally not logged.

## Observability

`src/observability.ts` is the single entry point for client observability.
`initObservability()` — the only startup call in `index.tsx` — installs the
global crash handler, registers the background-push and CallKeep listeners, and
reports any registration failure as a startup degradation.

All events are structured and levelled (`emitEvent`, `emitMetric`,
`recordDegradation`) and fan out to pluggable sinks: the in-memory/durable app
log by default, plus anything registered with `addSink` (Crashlytics, server
upload, …). Metrics currently emitted include call QoS (setup, first-frame and
signaling latency), ICE failures, mid-call reconnects, and push/CallKeep
registration failures.

Every event carries a per-session **correlation ID** (`wt-…`), which is also
sent on the signaling handshake. The server echoes it on socket connection and
logs a `call.correlation callId=… correlationId=…` line, so a failed call can
be traced from the device log through the server log.

## Build a debug APK locally

```bash
cd android
./gradlew assembleDebug
# => android/app/build/outputs/apk/debug/app-debug.apk
```

> **Note:** The debug APK loads JavaScript from the Metro bundler at runtime.
> Installing it on a device without Metro running will produce an
> _"Unable to load script"_ error. Use `assembleRelease` below for a
> self-contained APK.

## Build a release APK locally

The release build bundles the JavaScript at compile time — no Metro server
required. Set the desired env vars before running Gradle:

```bash
export SIGNALING_URL=https://<your-signaling-host>
export ROOM_ID=room-1
export TURN_USERNAME=<legacy_turn_username>
export TURN_CREDENTIAL=<legacy_turn_credential>

cd android
./gradlew assembleRelease
# => android/app/build/outputs/apk/release/app-release.apk
```

## Other scripts

```bash
npm run lint       # eslint
npm test           # jest
```
