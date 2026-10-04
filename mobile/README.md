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

## Lint tooling

The React Native ESLint preset used by this app (`@react-native/eslint-config`
0.87.x) supports ESLint 8 and 9, but not ESLint 10. Keep mobile on ESLint 9,
even though npm warns that this ESLint line is deprecated, and run lint through
the existing legacy `.eslintrc.js` script until the React Native preset supports
flat config/ESLint 10. The lint script sets `ESLINT_USE_FLAT_CONFIG=false` via
`cross-env` so legacy config mode also works on Windows shells. The
`eslint-plugin-ft-flow` override upgrades the
preset's transitive ft-flow v2 dependency to the version declared in
`devDependencies`, which is compatible with ESLint 9; remove it when the preset
itself depends on ft-flow >= 3 or when the app migrates to flat config.

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

## Audio-only calls

Audio calls request microphone access and acquire no camera track on either
device. The incoming notification identifies the media mode; call history and
redial use the initial mode saved by the server. Enabling the camera during an
audio call is an explicit action and requests camera permission at that point.
Switching cameras cannot implicitly enable video.

Deploy migration `0014_call_media_type` with the server's existing
`npm run db:migrate` command before starting the updated backend, then update
both clients together. There is no legacy-client rejection gate. Historical
server records default to video because their original modality was not saved.

Before release, verify on the two Android devices:

- Deny camera permission and complete an audio call in both directions,
  including an incoming call while the app is backgrounded/locked.
- Check that the camera privacy indicator never appears during audio-only use.
- Enable video explicitly: denial must leave audio running; granting access
  must deliver video to the other participant.
- Cancel/decline an audio call, then place a video call; no deferred camera
  toggle from the earlier call may affect it.
- Exercise network handoff, hang-up during media acquisition, and history/redial
  after restart. Confirm microphone/camera indicators stop after hang-up.

JavaScript tests do not replace these physical-device checks. iOS build
validation is deferred.

## Message notifications

Android chat messages use the versioned native channel
`wetalk_messages.v2`. The id was bumped from `wetalk_messages.v1` because
Android freezes a notification channel's importance and sound the first time it
is created; deleting the old id and posting to a new high-importance channel is
the only way upgraded installs can receive heads-up message popups. The channel
must stay `IMPORTANCE_HIGH`, with vibration, badge display and an explicit
default notification sound. The notification itself uses `PRIORITY_HIGH`,
`DEFAULT_ALL`, `CATEGORY_MESSAGE`, a `MessagingStyle` stack and the existing
`wetalk://chat/{conversationId}` content intent. Do not add a `notification`
block to the push payload: message pushes are data-only so the app's background
handler can apply privacy, mute and quiet-hours rules before rendering.

Foreground delivery has a separate in-app banner because Android does not show
heads-up popups for the app's own notifications while the app is open. The
banner is queued, not stacked; tapping it opens the chat deep link, and it is
suppressed by the same rules as OS notifications: disabled message
notifications, muted peers, message quiet hours and the target conversation
already being on screen. It renders through the same preview formatter as the
OS notification, so generic/sender/full preview modes and attachment previews
match exactly.

Before release, verify message notifications on Android:

- Fresh install: background and killed-app text messages produce a heads-up
  popup and open the right conversation when tapped.
- Upgraded install that previously created `wetalk_messages.v1`: the old
  channel is deleted, `wetalk_messages.v2` is created, and background/killed
  messages heads-up without reinstalling.
- Foreground on chat list, settings and a different conversation: the in-app
  banner appears; foreground on the same conversation: no banner or OS
  notification appears.
- Attachment messages keep their server-provided previews unchanged (`📷 Photo`,
  `📎 <name>`, `🎤 Voice message`) on both the OS notification and in-app
  banner.
- Muted peer, disabled message notifications and active message quiet hours
  suppress both OS and in-app surfaces.

## Local data and synchronization

Structured mobile data uses **SQLite through `@op-engineering/op-sqlite`**,
an asynchronous JSI binding. SQLite was chosen for indexed row access,
atomic transactions and recovery after interruption, rather than treating a
key/value store as a message database. There is no universally fastest database:
device-level latency and energy measurements are still needed before making
comparative performance claims.

The database is `wetalk-local.sqlite` in the app-private documents directory.
WAL permits recovery; `synchronous=FULL` prioritizes outbox durability over
maximum write throughput. Versioned schema initialization is transactional.
Changed rows are upserted in a single batch, with unchanged peer histories
reused instead of repeatedly sorting/serializing the entire chat document.
Every SQL value is bound, not interpolated.

| Data | Local copy | Synchronization / authority |
| --- | --- | --- |
| Conversations, messages, call timeline | SQLite; up to 100 recent histories and 200 entries per peer, plus pinned unsent messages/draft peers | Hydrate before rendering; refresh on registration, reconnect, foreground, opening a chat and manual refresh. Revalidate up to two 100-row pages for a cached chat; older pages remain on demand. |
| Outgoing text and uploaded attachments | SQLite outbox and optimistic message | Commit before any socket send. Composition returns after the local commit, without waiting for a network acknowledgement. Retry with the original compose-time UUID `clientMessageId`; server acknowledgements reconcile the provisional UUID to the persisted server ID/timestamp. Disk failure blocks sending and surfaces an error. |

SQLite schema v2 migrates queued sends into a dedicated `outbox` table while
preserving identities and account/server scopes. Each row retains its attempt
count, last error, pending/failed state, and next-attempt deadline across restart.
A single worker drains on startup, socket connect, and foreground. Failed attempt
N schedules a delay between half and all of `min(1000 * 2^(N-1), 60000)` ms;
reconnect and foreground do not reset that deadline. A delayed conversation head
gates later messages in that conversation without blocking other conversations.
After five failed attempts, or an immediate structured permanent rejection
(`bad_request`, `blocked`, `forbidden`, `not_found`, `unauthorized`, or
`unsupported_version`), the bubble shows the existing retry affordance instead
of retrying automatically. Explicit retry resets the budget and deadline while
keeping the client identity. Terminal failed rows no longer block later sends;
replies to failed parents remain unsendable until the parent succeeds.
| Drafts | SQLite, local only | Debounced edits; flush on background/unmount. No automatic cross-device draft overwrite. |
| Recent calls / missed-call acknowledgement / media type | SQLite recent-call cache; existing local media-type preferences | Cached calls render offline. Refresh on reconnect, foreground and existing call events. Preserve local read acknowledgement when fetching server rows. |
| Block list | SQLite snapshot | Refresh on connect/foreground and update after successful mutations. Server still enforces blocks; block/unblock is not replayed offline. Directory caches are invalidated after block updates. |
| Directory searches | SQLite, 30 query/limit combinations per account | Reuse for 60 seconds; then fetch. Network/5xx failure may fall back to a copy younger than 7 days; authorization failures never do. Cached rows contain no presence status. |
| Message search | Already-hydrated local messages | Server search when available; cached, non-deleted messages provide an offline fallback. This is not a full offline archive. |
| Attachments / voice recordings | Existing filesystem cache, not database BLOBs | Existing download-on-demand/cache reuse remains; observed tombstones evict downloaded attachments, including tombstones obtained while refreshing history. Unfinished uploads still require retry. |
| Theme, device settings, navigation, recent searches, played voice notes, notification preferences | Existing small local preference files | Local/device-specific; moving these tiny records adds migration risk without the chat-store write savings. No server settings-sync contract exists. |
| Presence, typing, active call state, WebRTC/TURN credentials | Live memory / existing platform services | Never restored as authoritative from a durable cache. Calls require a live server. Firebase retains authentication credentials in its native SDK, not SQLite. |

Concurrent conversation/history/call refreshes share in-flight requests; later
refreshes are never suppressed by a success or failure cache. The server remains
authoritative for receipts, reactions and deletions. Pagination keeps complete
timestamp/type/ID cursors, and refreshes cannot resurrect a known tombstone.
Only sends have durable offline replay: deletions, reactions and read-all requests
remain online operations. In particular, replaying an old read-all request would
incorrectly mark messages received later as read.

New text and attachment sends mint `clientMessageId` once, before the durable
queue write (before uploading for attachment placeholders). History, live events,
receipts and acks match `(senderId, clientMessageId)` so a receipt arriving before
the ack or a restart with a retained outbox cannot create a second bubble.
Legacy queued rows without an explicit key still emit their original `messageId`.
The persisted server ID/timestamp replaces the provisional row, but the local
compose timestamp and already-known receipts survive. Sender scoping also applies
to local search and key aliases, so two participants reusing a UUID stay distinct.

Replies to optimistic messages wait for the parent server ID. The resolved
`replyTo` is committed to the outbox before emit, ensuring a lost-ack replay sends
identical content; loaded optimistic replies and draft quote lookups also reconcile
the provisional alias. Uploaded group sends retain their group conversation
target rather than falling through to direct-message targeting.

Replies awaiting an optimistic parent retain a local-only dependency marker in
SQLite. Waiting replies pause later sends in that conversation, not independent
conversations. A failed/exhausted or discarded parent marks the dependent reply
failed with a clear reason and retains its original key for manual retry; it
does not indefinitely block other sendable rows. A parent ack rewrites queued
reply references, and each drain reloads the latest queued row before emitting.
Previously persisted legacy outbox entries still replay without an explicit key.

### Account isolation, upgrades and limits

Production cache scopes combine the configured server with the signed-in
Firebase account UID, not an editable username. Signed-out screens do not
hydrate an account cache, and late responses from an old scope are ignored.
Sign-out hides, rather than deletes, the scoped cache and queued messages; the
same account can resume them after signing in again. This is sandbox-protected
SQLite, **not application-level encryption or end-to-end encryption**. Android
backup is already disabled; platform device protection remains important.

The old `wetalk-chat.json` contains no trustworthy account/server ownership.
It is retained untouched rather than risking replay of another account's sends.
Only a legacy snapshot explicitly tagged with a matching `ownerScope` can be
automatically imported, with its migration marker in the same transaction.
For existing untagged installations, server history repopulates online; old
local-only drafts/unsent messages are **not automatically imported**. Do not
delete that file before any required owner-verified recovery.

Caches can be stale offline and are bounded, not a server replica. There is no
server change-feed or background-execution guarantee: changes to older unloaded
history are reconciled when those pages are fetched. No new polling runs while
the app is backgrounded. Debounced draft edits can lose their final interval if
the OS kills the process without a background event; committed outbox rows do
not depend on that event.

After adding/updating the native SQLite dependency, rebuild Android and run
`bundle exec pod install` from `mobile/ios` on macOS before rebuilding iOS.
Jest uses Node's built-in SQLite to test real SQL and rollback behavior; native
JSI initialization and on-device performance still require device validation.

## Profile presentation

Identity surfaces use `shared/identity.ts` to show the display name when set,
otherwise the user ID. Routing, call handles, and actions always retain the
user ID. Directory caches retain display names and avatar keys, not presence.
Profile and signed-avatar resolution is scoped to the current account and
server; avatars use the authorised `/avatar/download` endpoint and fall back
to initials when unavailable or when image loading fails.

Incoming-call pushes carry `callerDisplayName` so the system call UI can show
the caller's name even during a cold start. Message previews use the sender's
display name; generic notification previews still hide identity and content.

## Run the app

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

## Call-flow code map

`useCallFlow` composes the call lifecycle; concern-specific work lives in sibling
hooks under `src/hooks/`:

| Concern | Module |
| --- | --- |
| Local preview, camera switching and track lifecycle | `useLocalMedia.ts` |
| Peer connection creation and media negotiation | `usePeerConnection.ts` |
| Socket lifecycle and signaling event handlers | `useSignalingSocket.ts` |
| Connection-quality sampling and candidate-pair diagnostics | `useConnectionQuality.ts` |
| Status, summary, remote-media indicators and recovery presentation state | `useCallPresentation.ts` |
| Recovery episodes and heartbeat scheduling | `useCallRecovery.ts`, `useCallHeartbeat.ts` |
| DTLS fingerprint probe, SAS derivation and the verification log | `useCallSecurity.ts` |

Pure decisions remain in `src/call/`. The reducer, call setup/teardown ordering,
and memoized public state/action snapshot stay in `useCallFlow`. Presentation
setters do not drive lifecycle transitions or start timers; the orchestrator
and recovery hook decide when to update or reset them. Existing imports from
`useCallFlow` remain supported.

## Call verification (SAS)

WebRTC already encrypts call media with DTLS/SRTP, but the signalling server
brokers the SDP and could in principle substitute fingerprints to sit in the
middle of a call. A Short Authentication String lets the two people rule that
out themselves, with no extra key exchange.

`useCallSecurity` reads the local and remote DTLS fingerprints out of the peer
connection's negotiated SDP (`src/call/callFingerprints.ts`), and
`src/call/sas.ts` sorts the pair, hashes it with a domain separator, and maps
the first four digest bytes onto a fixed 256-word list. Sorting makes the code
order-independent, so both peers derive the same four words. Tapping the shield
badge in the in-call top bar reveals them; read them aloud, and if they match on
both phones nobody is in the middle.

Confirming writes the fingerprint pair to `wetalk-call-verification.json`, and
`PeerProfileScreen` then shows a persistent verified marker for that peer. On
later calls the stored pair is re-checked:

| Situation | Result |
| --- | --- |
| Both fingerprints unchanged | Verified |
| Local fingerprint also changed | Unverified — certificates rotate per connection, so this is expected; compare again |
| Remote fingerprint changed while the local one held | **Loud warning** — the peer's key changed; re-compare before trusting the call |
| Fingerprints unreadable | Unavailable — the code is simply not offered |

The last row is the important one: fingerprint access varies by platform, and
the UI never claims a call is verified when it could not read the fingerprints,
the same honesty rule applied to `ScreenShareDelivery: 'unverified'`.

Insertable streams / SFrame and any key-exchange infrastructure are out of
scope; this is a comparison of keys WebRTC already negotiated.

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
- on an **audio-only call** there is no video sender to borrow, so one is
  added for the share and removed again on stop — left in place it would keep
  the remote peer on the last captured frame for the rest of the call;
- disables the camera on/off and camera-switch buttons while sharing.

### Encoding tuned for screen content

Screen content (small text, sharp edges) degrades far more visibly than a face
under the camera's default encoder settings, which favour a stable frame rate
over resolution. `attachScreenVideo` (`src/hooks/useScreenShare.ts`) raises the
outgoing sender's parameters for the duration of the share:

- `videoTrack.contentHint = 'detail'`, so the encoder favours sharpness over
  motion smoothness;
- `RTCRtpSender.setParameters` with `degradationPreference:
  'maintain-resolution'`, a raised `maxBitrate` (~2.5 Mbps) and
  `scaleResolutionDownBy: 1`, so a constrained link drops frames rather than
  resolution.

The sender's parameters from before the share are captured and restored by
`restoreCameraTrack` once sharing stops, so a camera-only call that follows a
share keeps its original settings. Every step is guarded: `setParameters`,
`getParameters` and `contentHint` are not available on every
`react-native-webrtc` runtime, and a failure is logged with `logWarn` rather
than thrown — a soft picture is far better than a share that fails to start.

### Viewer rendering

When the remote peer is sharing (`isRemoteScreenSharing` in `useCallFlow`),
`CallStage` renders their video with `objectFit: 'contain'` instead of the
camera's `cover` layout, so the shared content is always letterboxed rather
than cropped, plus a small "`<name>` is sharing their screen" label. The local
self-view keeps its usual draggable thumbnail.

### In-call sharing indicator

While `isScreenSharing` is true, `CallControls` shows a persistent pill above
the Leave button instead of relying on the transient status banner: "You're
sharing your screen" (plus "with system audio" when audio is included), an
icon reflecting `screenShareDelivery` (a spinner while `checking`, a tick once
`confirmed`, a warning affordance plus the existing guidance text when
`unverified`), and a direct **Stop** action. The status banner is still used
for one-shot events — errors, cancellation, and the system-audio fallback.

### Optional screen audio

Next to the share button is a **screen audio** toggle, equivalent to the MS
Teams _Include computer sound_ option. It applies to the next share and cannot
be changed mid-share (that would churn the SDP).

On **Android** the audio is captured natively and mixed into the microphone
track the call is already sending, so there is no extra sender and **no
renegotiation** — an unmodified peer hears it immediately. On every other
platform the capture falls back to asking `getDisplayMedia` for an audio track;
if one comes back it is added as an additional sender, and if not the share
still starts and the UI says audio was not included.

#### How Android system audio works

`getDisplayMedia` cannot deliver it: `react-native-webrtc` declares
`getDisplayMedia()` **without parameters**, so the constraints object never
reaches the native module, and both native implementations build a video-only
stream. No permission can change that — the manifest already carries
`RECORD_AUDIO` and `FOREGROUND_SERVICE_MEDIA_PROJECTION`.

Patching `react-native-webrtc` to forward the constraint would produce PCM and
leave nowhere to put it: libwebrtc has no external or push audio source. So the
audio takes the other route. `com.wetalk.screenaudio` installs a custom
`JavaAudioDeviceModule` (via `WebRTCModuleOptions.audioDeviceModule`, from
`MainApplication.onCreate`) whose `AudioBufferCallback` receives the recording
buffer every 10 ms, and adds playback captured with
`AudioPlaybackCaptureConfiguration` into it.

Three things follow, and all three are load-bearing:

- **The WebRTC build matters.** `mobile/android/build.gradle` substitutes
  `org.jitsi:webrtc` with `io.github.webrtc-sdk:android`, which is the build
  that has the callback. Run `tools/webrtc-audio-probe/probe.sh` before
  changing that version; a failure there means system audio is broken on it.
- **Mute is routed, not toggled.** Both streams share one track, so disabling
  it would silence both. While sharing, `useCallAudioRouting` mutes at the
  audio device module — libwebrtc zeroes the microphone *before* the mixing
  callback runs, so the shared audio survives.
- **The MediaProjection is borrowed.** Android allows one at a time and stops
  the old one when a new one starts, so requesting separate consent for audio
  would stop the screen share. `mobile/patches/react-native-webrtc+124.0.7.patch`
  publishes the running capturer's projection so the capture can reuse it.

Playback capture is opt-out per source app (`ALLOW_CAPTURE_BY_NONE`) and never
available for DRM audio, so "capturing" and "the far end can hear something"
are different facts. `screenAudio.ts` reports four states rather than a
boolean, and a capture that hears only silence says so instead of promising
audio. iOS has no equivalent and stays video-only. The full design, and what
still needs a device to verify, is in the
[Android system audio decision](../docs/android-system-audio-decision.md).

#### When there is no native mixer

Without it — iOS, or an older build — the capture asks `getDisplayMedia` for
audio and learns the answer from the result, because the capability cannot be
probed up front: `getDisplayMedia` ignores the `audio` key instead of
rejecting. A share that asked for audio and got none records the runtime as
unable to capture it (`isScreenAudioCaptureSupported`). From then on the
request is not repeated, `useScreenShare` clears the preference and reports
`isScreenAudioSupported: false`, and the sheet row reads _"Not supported on
this device"_ instead of silently dropping the request and warning after every
share. A refused consent never disables the option: it says nothing about the
capability.

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
  System audio adds three more requirements, all checked by
  `tools/webrtc-audio-probe/probe.sh`: the WebRTC substitution in
  `android/build.gradle` (keep `app/gradle.lockfile` in step with it), the
  `react-native-webrtc` patch that publishes the active MediaProjection, and
  `ScreenAudioDevice.install(this)` in `MainApplication.onCreate` — which must
  run *before* `loadReactNative`, since `WebRTCModule` reads the audio device
  module in its constructor. If any is missing the call still works and
  sharing stays silent: `ScreenAudio.getStatus()` reports `unavailable`.
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
global crash handler, initialises optional crash reporting, registers the
background-push and CallKeep listeners, and reports any registration failure as
a startup degradation.

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

### Crash reporting

Off-device crash reporting (`@sentry/react-native`, chosen in
[`docs/crash-reporting-decision.md`](../docs/crash-reporting-decision.md)) is
**optional on every axis**:

- `src/crashReporting.ts` loads the SDK through a guarded lazy `require`, the
  same pattern as `loadMessaging()` and `loadCallKeep()`, so a bundle or Jest
  run without the native module still works — `mobile-ci.yml` installs no
  native modules.
- It is off unless `SENTRY_DSN` is set at build time; Babel inlines it into the
  bundle exactly like `SIGNALING_URL` (`android-apk.yml` passes the secret).
- Android applies Sentry's Gradle integration only when
  `android/sentry.properties` exists, mirroring how the Google Services plugin
  is applied only with `google-services.json`, so credential-free builds (CI
  and local) assemble unchanged. The uploads it adds — R8 mapping, native
  symbols, source context — are what need those credentials.
- iOS autolinks RNSentry through `use_native_modules!` and needs no Sentry
  credentials to install or build.

Once enabled it reports native and JavaScript crashes, and every observability
event is forwarded as a redacted breadcrumb. The on-device crash log
(`src/crashReporter.ts`) and the app-log sink are kept either way; a configured
but unusable reporter is reported as a `crashReporting` startup degradation.

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
# Optional: enables crash reporting. Omit it and reporting stays off.
export SENTRY_DSN=https://<key>@<sentry-host>/<project>

cd android
./gradlew assembleRelease
# => android/app/build/outputs/apk/release/app-release.apk
```

### Shrinking

The release build runs R8 (`minifyEnabled`) and the resource shrinker
(`shrinkResources`); debug builds do not, so a crash that only reproduces on a
release APK is usually a missing keep rule. Together they cut the arm64-v8a APK
from ~48 MiB to ~40 MiB, almost all of it dead bytecode (four dex files become
one) plus the unused resources and non-English translations of AndroidX, Play
Services and Firebase.

Two things shrinking cannot see, both of which fail only at runtime:

- **Classes reached from native code.** Libraries that bind JNI symbols to a
  fully-qualified class name break when R8 renames the class. React Native,
  Reanimated, Worklets, WebRTC and Firebase ship consumer rules; the ones that
  do not are kept explicitly in `android/app/proguard-rules.pro`.
- **Resources resolved by `getIdentifier()`**, such as the screen-share
  notification icon and the google-services generated strings. These are listed
  in `android/app/src/main/res/raw/keep_wetalk.xml` — deliberately *not* named
  `keep.xml`, which the React Native bundler generates and would override.

After adding a dependency that uses either mechanism, add the matching rule and
smoke-test a release APK on a device. `__tests__/androidReleaseShrinking.test.ts`
guards the configuration itself, and
`android/app/build/outputs/mapping/release/` holds the R8 mapping plus the
`resources.txt` report listing every resource that was dropped.

R8 loads the entire class graph into the Gradle JVM, so `org.gradle.jvmargs` in
`android/gradle.properties` allots it 4 GiB of heap and 1 GiB of metaspace —
well above the React Native template's 2 GiB/512 MiB, which is not enough for
this dependency set. An undersized JVM does not fail cleanly: R8 dies and the
daemon then spins on `OutOfMemoryError: Metaspace` without exiting, so the build
hangs. `-XX:+ExitOnOutOfMemoryError` is set as a backstop, and the CI job caps
itself with `timeout-minutes` rather than relying on GitHub's 6-hour limit.

## Group chat local preview

In **Chats → New group**, search the authenticated `GET /users` directory,
select at least two other people, and enter a name. Selections survive search
changes. The mixed chat list shows group names and unread badges; tapping a
group opens its own restorable navigation route. Direct chats/calls are unchanged.

### Default mock and opt-in live transport

New groups default to **local mocks**, scoped to the signed-in account and
signaling server. Creation, renaming, admin-only add/remove, leaving, messages,
drafts, and per-member read summaries use the existing SQLite chat store.
Offline group sends reuse the existing durable outbox, original `clientMessageId` values,
retry policy, and flush-before-send gate. Reconnecting completes mock sends
locally; it does **not** deliver them to another device. Leaving disables sends
and automatic replay while retaining failed queued bubbles.
Queued groups retain their membership snapshots even beyond the normal
conversation retention window, so a restored send never becomes a direct send.

To create real server groups, set `GROUP_TRANSPORT=live` when starting Metro
(restart/reset its cache after changing the flag), or when building the JS bundle:

```bash
GROUP_TRANSPORT=live npm start -- --reset-cache
```

The creation sheet clearly labels live invitations. Existing mock groups stay
local even with this flag; they are never automatically promoted or uploaded.
Existing server groups discovered by REST always use live transport.

The server **already implements** group create/update/leave and group-call
lifecycle handlers in `server/src/signaling/conversationHandlers.ts`. Live
creation, renaming and leaving validate the handlers' `{ conversation }`
acknowledgements using the frozen snapshot schema. Live calls likewise consume
the implemented `{ call, participants }` acknowledgement and validated broadcasts.
No role/member-mutation wire fields are invented.

`GET /conversations` returns direct summaries in `conversations` and bare group
snapshots in `groupConversations`; both populate the mixed list. Live group
history/refresh/pagination use the implemented
`GET /conversations/:conversationId/messages` endpoint, including `before` and
`beforeMessageId`. Offline live sends reuse the same durable outbox but deliver
to the server using only `conversationId`.

**Members** exposes clearly labeled local simulations for another member's
typing, read receipt, and incoming message. Typing expires automatically.
Admin UI gates mean the snapshot's `creatorId`; no new role or member-mutation
wire format is inferred. The mock does not transfer creator privileges.
The live server maintains owner/admin roles and transfers ownership internally,
but its exposed snapshots do not contain those roles: the mobile gate therefore
remains conservatively creator-only rather than inferring a successor's rights.

**Group call preview** follows the actual frozen `schemas.ts` contract:
`conversation.call.start` (`conversationId`, optional `mediaType`) and
`conversation.call.accept/decline/leave` (`callId`), all with `version: 2`.
Validated `conversation.call.updated` snapshots drive the participant grid,
including `ringing/accepted/declined/left`, participant timestamps, and call
`stateVersion`. Types are derived from that schema, not the stale shared README.
Mock groups produce these same validated snapshots locally; remote groups use
the real lifecycle signaling and may notify other participants. There is still
**no actual media**, microphone/camera access, or WebRTC connection. Mute is a
local-only simulation, never a new wire field/event. Other-member lifecycle
simulation is available only in local mock groups. Peer-call events are never
used. Closing the sheet does not leave a call; use **Leave preview**.
Preview call snapshots are ephemeral and account-scoped; restoring an already
active call after a cold launch and actual media remain follow-up integration work.

The mobile client accepts validated `conversation.updated` snapshots and
conversation-scoped message/typing/read events. Non-mock sends and typing
target exactly `conversationId`; direct sends continue to target only
`recipientId`. The remaining limitations are **group read synchronization,
member add/remove, role exposure, cold-start active-call recovery, and actual
group media**, not the existing creation/history/lifecycle handlers.
The implemented `POST /messages/read` endpoint is direct-only, and REST group
snapshots do not supply last-message or unread totals. Group unread counters
and read watermarks are local (plus any received conversation-scoped receipts),
not server-authoritative cross-device read state; the client never posts a
group ID as `peerId`. The shared contracts are unchanged.

Security boundary: the local adapter checks membership/admin gates independently
of disabled UI controls, mock flags never cross the wire, stale membership
snapshots are ignored, and SQLite scopes isolate accounts/servers. Server-side
authorization remains mandatory for all future remote member operations.

## Validation scripts

```bash
npm run lint       # eslint
npm run typecheck  # TypeScript
npm test           # jest
```
