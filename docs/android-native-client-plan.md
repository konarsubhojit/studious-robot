# Native Android client — rejected rewrite decision

Audited against `ab7591677e979d0a86b1137e99743fc5f3bdc5fd` on 2026-10-02.

## Decision

Do not start an Android-native rewrite to obtain screen-share system audio or
video calling. Both have implementations in the existing React Native client.
The abandoned shadowed-`WebRtcAudioRecord` / two-factory spike and its rewrite
tracker are not prerequisites for the shipped design.

`mobile/android/build.gradle` substitutes `io.github.webrtc-sdk:android` for
the upstream WebRTC dependency. `ScreenAudioDevice.kt` installs a custom
`JavaAudioDeviceModule` through `WebRTCModuleOptions.audioDeviceModule`;
`ScreenAudioMixer.kt` mixes playback capture into the microphone buffer.
This needs neither a second peer connection nor separate audio signalling.
See [the system-audio decision](./android-system-audio-decision.md) for the
implementation and outstanding hardware checks. Implemented does not mean
device-verified or universally capturable.

React Native is not the limiting audio layer: the capture/mixing code is Kotlin
inside the existing app. A rewrite would still need that native integration,
while also replacing UI, transport, auth, persistence and call orchestration.
A future native-client proposal therefore needs an independent, measured
motivation, not the already-delivered audio feature.

## Parity surface for any future proposal

| Area | Current source of truth | Porting constraint |
| --- | --- | --- |
| Calls | `mobile/src/hooks/useCallFlow.ts`, extracted concern hooks, `mobile/src/call/` | Preserve state-machine, recovery, ICE restart, SAS, answer and teardown semantics. |
| Messaging | `mobile/src/messaging/`, `mobile/src/hooks/useMessaging.ts` | Preserve stable `messageId` values and durable outbox retry semantics. |
| Local storage | `mobile/src/storage/chatDb.ts`, `localDatabase.ts`, `chatRecords.ts`; `@op-engineering/op-sqlite` in `mobile/package.json` | Decide explicitly how existing account/server-scoped data migrates. |
| UI | `mobile/src/components/`, theme and accessibility hooks | Port behaviour and accessibility, not just screenshots. |
| Transport and auth | `mobile/src/hooks/useSignalingSocket.ts`, `useSession.ts`, `mobile/src/authService.ts` | Preserve reconnect, refresh/revocation and verified-account ownership semantics. |
| Contracts | `shared/signaling/events.ts`, `shared/api/routes.ts` | Match event names, payloads, acknowledgements and error codes; do not fork the contract. |
| Native services | `mobile/android/app/src/main/java/com/wetalk/` | Assess reuse separately from React Native bridge bindings. |
| Attachments and media | `mobile/src/attachmentUpload.ts`, `attachmentDownload.ts`, `attachmentOpen.ts`, media and voice-note components | Preserve upload/download authorization, cache/open behaviour and account/server scoping. |
| Tests | `mobile/__tests__/` | Port behavioural assertions; JavaScript test code itself is not reusable Kotlin coverage. |

As measured on 2026-10-02, `useCallFlow.ts` contains **2,442 lines**. Its
extraction boundaries and the decision to retain coordinated teardown are
recorded in [CALLFLOW_EXTRACTION.md](./CALLFLOW_EXTRACTION.md).

## Contract fidelity and acceptance criteria for a future proposal

The existing UI decisions in `mobile/docs/UX_REDESIGN_PLAN.md` and
`mobile/docs/UI_REVAMP_TODO.md` remain useful porting inputs. A port should not
quietly become another redesign.

- Derive native DTOs from `shared/`, or pin hand-maintained DTOs with
  conformance tests. A client-local event literal drifting from the shared
  contract is a cross-platform compatibility failure.
- Validate calls, messages and attachments in both directions against the
  existing client. A native-only happy path is not parity.
- Treat any required server contract change as its own compatibility decision,
  rather than assuming a rewrite authorizes changes for existing clients.
- Port assertions for offline compose/process death/retry, read state,
  revocation, recovery and attachment scoping, not only screen appearance.
- Require a separate build/release path, an explicit parity budget and rollback
  plan before implementation approval. If parity cannot be reached, retire the
  experiment rather than maintain two divergent Android clients indefinitely.
- Keep the existing Android release available until parity and rollout are
  demonstrated. Decide iOS ownership and install-data migration explicitly.

## Risks that survive the rejected proposal

- Two clients speaking one contract can drift. Any wire change must remain
  compatible with the existing client and have conformance coverage.
- Running native Android alongside React Native permanently doubles feature
  and release maintenance unless retirement criteria are explicit.
- Retiring React Native on Android does not retire it on iOS. Platform support
  is a product decision, not an accidental consequence of a port.
- Session revocation, attachment scoping, blocking and SAS must not be
  re-derived with weaker semantics during reimplementation.
- Install migration and rollback must be decided before rollout; silently
  discarding local history is not an acceptable migration strategy.

No repository measurement establishes that a rewrite would improve call
quality, latency or reliability. Hardware verification of the current system
audio path remains separate from any rewrite decision.
