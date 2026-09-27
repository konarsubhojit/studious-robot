# Native Android client — evaluation and staged plan

Planning record for the request *"build an Android-native equivalent of the
mobile app instead of the React Native one, because of screen sharing with
system audio and video calling"*. It is written to be executed by successive
agent sessions: every phase has a scope, deliverables, acceptance criteria and
an exit gate, and [§9](#9-work-item-tracker) is the tracker those sessions
update.

> **Status: not authorized to start. Blocked on gate D0.**
> The stated motivation does not survive contact with the evidence already
> recorded in [Android system audio — capability decision](./android-system-audio-decision.md):
> React Native is **not** what blocks system audio, so "go native" is not by
> itself a fix. Exactly one native-only seam might unlock it
> ([§3](#3-the-one-thing-native-actually-buys)), and it is unverified. Run the
> D0 spike ([§4](#4-gate-d0--the-only-work-authorized-today)) and record its
> result here before any phase below is opened as an issue. Until then this
> document is an option, not a roadmap.

---

## 1. What was asked, and what is actually true

| Claim in the request | Verdict | Evidence |
| --- | --- | --- |
| "Screen sharing with system audio needs a native app." | **Unproven, and mostly false.** The audio constraint dies in libwebrtc's audio device module (ADM), three layers below React Native. A native app links the same libwebrtc and inherits the same ADM. | [android-system-audio-decision.md §1, §3](./android-system-audio-decision.md) |
| "Video calling needs a native app." | **False.** Video calling ships today on `react-native-webrtc` with ICE restart ladders, recovery episodes, SAS verification, PiP and CallKeep integration. No open defect attributes a call failure to the RN bridge. | `mobile/src/hooks/useCallFlow.ts`, `mobile/src/call/` |
| "A native app is an equivalent amount of work." | **False.** 195 source files / ~46.7k lines of app code plus 151 test files / ~41k lines of tests would be reimplemented, against an unchanged server. | counts over `mobile/src` and `mobile/__tests__` |

The honest framing is therefore inverted from the request: **a rewrite is the
expensive way to buy one uncertain capability.** This document keeps the option
open because the capability is genuinely wanted, but it refuses to present the
rewrite as the cause of the fix. If the D0 spike shows the seam in
[§3](#3-the-one-thing-native-actually-buys) works, the far cheaper delivery is
[§5, Option A](#5-three-delivery-shapes--pick-one-at-d1) — the same Kotlin
capture code behind a React Native native module — and the rewrite remains
unjustified.

## 2. Why "React Native is in the way" is wrong

From the source and binary inspection recorded in the decision record:

- `PeerConnectionFactory.createAudioSource(MediaConstraints)` is the only way to
  make an `AudioSource`, and it always binds the process-global ADM of its
  factory. There is no external/push audio source in the Java API.
- `JavaAudioDeviceModule.Builder` accepts only `setAudioSource(int)` — a
  `MediaRecorder.AudioSource` constant. An `AudioPlaybackCaptureConfiguration`
  cannot be expressed as one.
- Replacing the ADM means shipping a C++ object; the prebuilt AAR has `.so`
  files and no headers.
- The one Java-level seam is *shadowing* the package-private
  `org.webrtc.audio.WebRtcAudioRecord` so the app's copy precedes the AAR's on
  the classpath, and building the `AudioRecord` there with
  `setAudioPlaybackCaptureConfig(...)`.

None of those five facts mention React Native. Kotlin does not change any of
them. Anything a rewrite can do about system audio, a native module inside the
existing app can do too — with one exception, which is the next section.

## 3. The one thing native actually buys

`react-native-webrtc` owns its `PeerConnectionFactory`: the app never
constructs one and cannot pass `PeerConnectionFactory.Builder.setAudioDeviceModule()`.
A native app constructs its own factories, which makes a **two-factory
topology** expressible:

| | Factory A | Factory B |
| --- | --- | --- |
| ADM | default (microphone) | `JavaAudioDeviceModule` built for playback capture |
| Tracks | mic audio, camera video, screen video | system-audio only |
| Carried on | the existing peer connection | a **second** peer connection to the same peer |

This is the only shape in which a live microphone and captured system audio can
be two independent tracks without owning a libwebrtc build. Tracks are not
interchangeable across factories, so the second factory needs its own peer
connection, its own DTLS handshake and its own signalling.

**Treat this as a hypothesis with three unproven steps, not a design.**

1. Whether a shadowed `WebRtcAudioRecord` can be made *conditional* — playback
   capture for factory B, ordinary mic for factory A — given that class
   shadowing is process-wide. **Statically de-risked** (see §3.1): the audio
   source is a plain `int` carried from
   `JavaAudioDeviceModule.Builder.setAudioSource(int)` into a
   `WebRtcAudioRecord` field, and no JNI entry point reads it, so a sentinel
   constant is expressible. Whether the resulting `AudioRecord` initialises is
   still a device question.
2. Whether two ADMs can initialize concurrently in one process at all. Only a
   device can answer this.
3. Whether the second peer connection is acceptable: doubled ICE/TURN usage,
   a second `call.media-state` lifecycle, no lip-sync guarantee with screen
   video on the first connection, and a new failure mode where the screen-audio
   connection dies while the call survives.

If step 1 or 2 fails, native buys nothing over React Native, and the only
remaining path to separate tracks is a custom libwebrtc build (option 2 of the
decision record) — which the decision record already shows is independent of
the UI framework.

### 3.1 Static verification — done, and repeatable

Every API fact above and in the decision record's §3 has been re-verified
against the real bytecode of `org.jitsi:webrtc:124.0.0`, and the inspection is
now a script rather than prose: [`tools/webrtc-audio-probe`](../tools/webrtc-audio-probe/README.md).
It needs no Android SDK, emulator or device, and it runs in about a minute.

| Verified claim | Consequence |
| --- | --- |
| `org.webrtc.audio.WebRtcAudioRecord` is package-private and non-final | The shadowing seam is open at this version. |
| `nativeCreateAudioDeviceModule` is typed to the **concrete** `WebRtcAudioRecord` | Subclassing cannot work; shadowing is the only Java seam. |
| `JavaAudioDeviceModule.Builder.setAudioSource(int)` exists; `WebRtcAudioRecord`'s public constructor takes that `int` | A sentinel audio-source constant can select playback capture per ADM — this is what makes step 1 above plausible. |
| `createAudioRecordOnMOrHigher` is `private static` | A shadow must reimplement the **whole** class; it cannot delegate or override. See the risk below. |
| `PeerConnectionFactory.Builder.setAudioDeviceModule` is public | The two-factory topology is constructible — the one thing native adds. |
| `createAudioSource(MediaConstraints)` is the only `AudioSource` route, and `AudioDeviceModule` exposes only a native pointer | No external/push audio source; PCM cannot be fed in. Confirms a `patch-package` patch cannot deliver this. |

**Newly discovered risk — there is no upstream source to patch.** The published
`webrtc-124.0.0-sources.jar` is a stub containing a single
`org/jitsi/webrtc/NothingToSeeHere.java`. Combined with
`createAudioRecordOnMOrHigher` being private static, a shadow cannot be produced
as a small diff against vendored sources. It must be hand-written against the
bytecode, or lifted from upstream `webrtc.googlesource.com` and matched to the
AAR's exact revision by hand. Three things follow, and D0 must budget for them:

- The shadow is **several hundred lines of reimplemented third-party code**,
  carrying its own BSD-3 header and provenance note, not a patch.
- Its correctness cannot be diffed against an original, so it needs its own
  tests and its own review.
- A WebRTC version bump silently desynchronises it. The AAR version becomes
  load-bearing: pin it, and re-run the probe on every bump.

This does not change the go/no-go, but it materially raises the cost of the
"cheap" option and is exactly the kind of finding that belongs **before**
someone books device time.


## 4. Gate D0 — the only work authorized today

Run the spike protocol in
[android-system-audio-decision.md §5](./android-system-audio-decision.md#5-spike-protocol--ordered-to-fail-fast),
in a throwaway app, on real hardware, extended by one step:

| Step | Question | Fail ⇒ |
| --- | --- | --- |
| D0.0 | *(desk, no device)* Do the libwebrtc API seams still exist? `tools/webrtc-audio-probe/probe.sh` | Seam closed ⇒ stop; system audio needs a custom libwebrtc build on either stack. **Status: run, 9/9 passing at `org.jitsi:webrtc:124.0.0` — see §3.1.** |
| D0.1 | Does a synthetic tone pushed through a shadowed `WebRtcAudioRecord` reach a second device? | Stop. No rewrite can help. Record the result and close this document. |
| D0.2 | Can a live microphone track survive alongside it in **one** factory? | Expected to fail; proceed to D0.3. |
| D0.3 | *(native-only, new)* Do two `PeerConnectionFactory` instances with two ADMs coexist, one mic and one playback capture, with both tracks live on two peer connections? | Native buys nothing. Choose option 1 or 3 of the decision record and close this document. |
| D0.4 | Does real `MediaProjection` + `AudioPlaybackCaptureConfiguration` (API 29+) capture from a permitting app, and degrade cleanly against `ALLOW_CAPTURE_BY_NONE`? | Ship the capability as unavailable-by-detection, not as a promise. |

Run D0.0 first and re-run it whenever the WebRTC version changes; it is the
only step that can be answered without hardware, and it costs a minute.

Before booking device time, note the shadow-authoring cost recorded in §3.1:
D0.1 is not "write a few lines", it is "reimplement `WebRtcAudioRecord` from
bytecode". Budget that into the spike, not into the phase after it.

Record the outcome as a new section in this file (`## D0 result — <date>`),
including device models and OS versions. D0.1–D0.4 need a human with hardware;
CI has no Android device or emulator.

**Exit gate.** D0.1 and D0.3 both green ⇒ proceed to D1. Anything else ⇒ this
document is closed as *no-go* and the request is answered with the decision
record's option 1 or 3.

## 5. Three delivery shapes — pick one at D1

D1 is a decision, not a phase, and it happens **after** D0 because D0's result
changes which options exist.

| | Shape | Cost | Keeps | Loses |
| --- | --- | --- | --- | --- |
| **A** | **Kotlin capture module inside the RN app.** The D0 code becomes a native module; RN keeps UI, signalling, call state and business logic. | Weeks. One module, one JS surface, no parity work. | All 195 source files, all 151 test files, iOS, one release train. | Nothing. A second peer connection is expressible from JS. |
| **B** | **Native Android app, RN app retired for Android.** Full parity rewrite. | Quarters. ~46.7k lines of app code plus its test suite. | Server, `shared/` contracts, the existing Kotlin native modules. | iOS (RN app must stay alive for it anyway), every mobile test, feature velocity until parity. |
| **C** | **Native Android app alongside the RN app.** | Quarters, then permanently doubled. | Everything, twice. | Every future feature is implemented twice, in two languages, against one contract. Explicitly the worst option; listed so it is rejected on purpose. |

> **Recommendation, stated in advance so it is not quietly lost: A.** The
> decision record already reached it independently — *"The right shape, if this
> ships, is a native Android capture module exposing `startScreenAudioCapture()`
> / `stopScreenAudioCapture()` to JS, with UI, signalling, call state, and
> business logic staying in React Native."* Choosing B requires a reason
> recorded here that is **not** system audio and **not** video calling, because
> neither survives §1. Legitimate reasons would be, for example, a measured
> startup/memory budget the RN app cannot meet, or an Android-only product
> direction that abandons iOS.

Phases P0–P9 below describe **shape B**, because that is what the request asked
for and what needs a plan; shape A needs only P1 and P2.

## 6. Parity surface (what shape B must reimplement)

Measured, not estimated:

| Area | Where it lives today | Notes for a native port |
| --- | --- | --- |
| Call flow | `mobile/src/hooks/useCallFlow.ts` (2,442 lines), `mobile/src/call/` (17 modules: state machine, ICE restart ladder, recovery episodes, answer path/timeline, SAS, push rehydration, session lifecycle, video adaptation) | The densest and most behavioural area. Port the pure modules (state machine, ladder, SAS, decisions) first; they are framework-free logic with direct Kotlin equivalents. |
| Messaging | `mobile/src/messaging/` (send/receive pipelines, durable outbox, history, drafts, identity, conversation projection), `mobile/src/hooks/useMessaging.ts` (1,183 lines) | Message identity and outbox semantics are contract-level; retries must remain idempotent by `messageId`. |
| Local store | `mobile/src/storage/` on `@op-engineering/op-sqlite` (`chatDb.ts`, 435 lines) | Maps to Room/SQLite. Same three logical tables, same server-keyed ids. Migration of an existing install's data is a separate decision — see P8. |
| UI | 56 components (37 screens/widgets + 18 primitives + 1 chat presentation) and 37 hooks, plus theme, accessibility, reduced motion, high contrast | Compose rewrite. The UX records in `mobile/docs/UX_REDESIGN_PLAN.md` and `mobile/docs/UI_REVAMP_TODO.md` are the design authority; do not redesign during a port. |
| Transport | `socket.io-client` + REST, contracts in `shared/signaling/events.ts` and `shared/api/routes.ts` | Socket.IO has a JVM client; protocol version, ack shapes and error codes must match exactly ([§7](#7-contract-fidelity-is-non-negotiable)). |
| Auth | Firebase Auth (email/password, Google, Microsoft), short-lived ID tokens, device registration/revocation | Firebase Android SDK directly. Session refresh and revocation recheck semantics are server-defined. |
| Notifications & telecom | Already Kotlin: `CallServiceModule`, `CallForegroundService`, `IncomingCallNotificationModule`, `IncomingCallActionReceiver`, `MessageNotificationModule`, `PendingCallStore`, `CallConnections`, `AttachmentOpenerModule` | **Reusable largely as-is** once the RN bridge annotations are stripped. This is the only area where shape B starts ahead. |
| Attachments | presign/upload/download/cache/open, media viewer, voice notes, audio playback | OkHttp + WorkManager; key-scoping rules are server-side and must not be re-derived on the client. |
| Tests | 151 files, ~41k lines | Not portable. Budget the port of the *assertions*, not the code; the behaviours they pin are the real specification. |

## 7. Contract fidelity is non-negotiable

`shared/` is the single authority for event names, payload schemas, REST routes
and error codes. A native client must not fork it.

- DTOs are **derived** from `shared/`, by generation if practical, by hand with
  a conformance test otherwise. A hand-typed literal `"call.media-state"` in
  Kotlin that drifts from `shared/signaling/events.ts` is a silent production
  break on one platform only.
- Every phase that touches the wire ships a conformance test that fails when
  `shared/` changes and Kotlin does not.
- Server changes are out of scope for this plan. If a phase appears to need a
  server change, stop and raise it as its own decision; "the native client
  needs it" is not a sufficient reason to change a contract two clients speak.

## 8. Phases (shape B)

Each phase is sized for one or a few agent sessions. **Do not start a phase
whose dependency is not green.** Phase status lives in [§9](#9-work-item-tracker).

### P0 — Repository and build skeleton
- **Deliver:** `android/` at the repo root (sibling of `mobile/`, never inside
  it — the Android APK workflow is path-filtered on `mobile/**` and must not
  start building two apps); Gradle version catalog; Kotlin + Compose; JDK 21 to
  match the existing APK workflow; `minSdk` decision (the RN app is 24, playback
  capture is 29+ — the native app should be **26+** and gate capture at 29);
  dependency locking, matching `mobile/android/build.gradle`.
- **Accept:** `./gradlew assembleDebug` and `./gradlew test` pass in CI on a
  hello-world app; no existing workflow's trigger, duration or output changes.
- **Do not:** add the app to `android-apk.yml`; give it its own workflow.

### P1 — Screen-audio capture module (the actual feature)
- **Depends on:** D0 green.
- **Deliver:** the D0 spike code, hardened: MediaProjection consent, foreground
  service with `mediaProjection` type, `AudioPlaybackCaptureConfiguration`,
  the second factory/ADM, and the **four-state** capability model the decision
  record requires — supported / supported-but-nothing-capturable / user-denied /
  platform-unsupported. Never a boolean.
- **Accept:** on-device, two participants, mic and system audio both audible and
  independently mutable; revoking projection mid-call ends capture without
  ending the call.
- **Note:** under shape A this phase *is* the project, and it lands in
  `mobile/android/` as a native module instead.

### P2 — Signalling for a second media connection
- **Depends on:** P1.
- **Deliver:** how the screen-audio peer connection is offered, answered,
  recovered and torn down within the existing call lifecycle, using existing
  events only. Receive-side merge already exists (`usePeerConnection.ts`
  `isAdditionalAudioOnlyRemoteStream` / `mergeScreenAudioTracks`) and defines
  the shape the far end expects.
- **Accept:** an RN peer (unchanged) renders and plays a native peer's screen
  audio, and vice versa. **Cross-client interop is the acceptance criterion for
  every phase from here on.**

### P3 — Transport, auth and session
- **Deliver:** Socket.IO client, REST client, Firebase Auth, session issue/
  refresh/revocation, device registration, TURN credential fetch, reconnect and
  draining behaviour.
- **Accept:** conformance tests against `shared/`; a native client survives a
  server drain and a device revocation exactly as the RN client does.

### P4 — Local store and offline semantics
- **Deliver:** Room schema mirroring `chatDb.ts`, durable outbox, retention,
  account/server scoping.
- **Accept:** compose offline → kill the process → message still sends once,
  with the same `messageId`; retention prunes without dangling pointers.

### P5 — One-to-one calling parity
- **Deliver:** call state machine, ICE restart ladder, recovery episodes,
  connection quality, audio routing, SAS verification, CallKeep/Telecom
  equivalent, PiP, call history and redial, audio-only modality.
- **Accept:** the physical-device checklist in `mobile/README.md` (audio-only
  calls, notifications) passes on the native client, both directions, against
  an RN peer.

### P6 — Messaging parity
- **Deliver:** send/receive pipelines, typing, reactions, edits/deletes, read
  state, search, drafts, blocks, conversation list projection.
- **Accept:** the behaviours pinned by `mobile/__tests__/messaging/**` hold, as
  Kotlin tests; ordering and unread counters match the server projection.

### P7 — Attachments and media
- **Deliver:** presign/upload/download, cache, storage usage, media viewer,
  voice notes, audio/video playback.
- **Accept:** an attachment sent from either client opens on the other; key
  scoping is untouched.

### P8 — UI, accessibility and migration
- **Deliver:** Compose screens to the existing UX records; accessibility
  announcements, reduced motion, high contrast, theming; notification
  preferences and quiet hours (local-only, account-scoped, as today); and the
  **install migration decision** — whether an updating device carries its
  `wetalk-chat` SQLite data and local preferences across, or starts clean with
  a server re-sync. Silent data loss on update is not acceptable.
- **Accept:** accessibility sweep passes; migration path exercised on a device
  with real history.

### P9 — Release, rollout and retirement
- **Deliver:** signing, its own CI workflow, staged rollout, crash/telemetry
  parity, and an explicit statement of what happens to the RN Android build.
- **Accept:** rollback plan exists and has been rehearsed. **The RN Android
  build is not removed** until the native client has reached parity *and* a
  rollout has held; iOS keeps the RN app alive regardless.

## 9. Work-item tracker

Agent sessions update this table in the same PR as the work. One row, one
session-sized unit. Status is `blocked` / `ready` / `in progress` / `done` /
`dropped`; a `dropped` row keeps a one-line reason.

| ID | Item | Phase | Depends on | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| AN-00 | This plan | — | — | done | Written; premise corrected in §1. |
| AN-01a | Static API verification, scripted | D0 | AN-00 | done | `tools/webrtc-audio-probe`, 9/9 at `webrtc:124.0.0`. Seams confirmed open; §3 step 1 de-risked; no-upstream-sources risk found (§3.1). |
| AN-01b | Run D0.1–D0.4 on hardware, record result in §4 | D0 | AN-01a | blocked | Needs a human with two Android devices. CI cannot do this. Budget the shadow-authoring cost in §3.1. |
| AN-02 | Choose delivery shape A/B/C, record the reason in §5 | D1 | AN-01b | blocked | If B, the reason must not be system audio or video calling. |
| AN-03 | Gradle/Compose skeleton under `android/` | P0 | AN-02 = B | blocked | |
| AN-04 | Screen-audio capture module | P1 | AN-01b green | blocked | Lands in `mobile/android/` under shape A. |
| AN-05 | Second-connection signalling | P2 | AN-04 | blocked | |
| AN-06 | Socket/REST/auth/session | P3 | AN-03 | blocked | |
| AN-07 | Room store and outbox | P4 | AN-03 | blocked | |
| AN-08 | Calling parity | P5 | AN-06 | blocked | Largest single item; split on first contact. |
| AN-09 | Messaging parity | P6 | AN-06, AN-07 | blocked | |
| AN-10 | Attachments and media | P7 | AN-06, AN-07 | blocked | |
| AN-11 | UI, accessibility, install migration | P8 | AN-08, AN-09, AN-10 | blocked | |
| AN-12 | Release, rollout, retirement statement | P9 | AN-11 | blocked | |

Rules for sessions picking up a row:

1. **Do not skip a gate.** AN-03 and everything after it stay `blocked` until
   AN-02 is recorded. A session that starts a rewrite phase without a recorded
   D1 decision has made the decision by accident.
2. **Split, don't inflate.** If a row cannot land in one session, replace it
   with sub-rows rather than carrying a half-done row.
3. **Keep the RN app green.** No phase may change `mobile/` behaviour, its
   tests, or its CI timings except AN-04 under shape A.
4. Follow the existing local workflows: `npm install` before typecheck/lint/test
   in `mobile/` and `server/`; mobile ESLint runs from inside `mobile/`;
   mobile Jest needs `--ci --forceExit`.

## 10. Risks and kill criteria

| Risk | Kill criterion |
| --- | --- |
| The motivating feature never works | D0.1 or D0.3 red ⇒ stop at D0. Do not "start the port anyway while we think about audio". |
| Two-client drift on one contract | Any phase that needs a `shared/` change that the RN client cannot also speak ⇒ stop and re-decide. |
| Parity never arrives; both clients rot | If P5+P6 are not complete within the budget agreed at D1, retire the native app rather than run shape C indefinitely. |
| iOS is silently abandoned | Shape B leaves iOS on React Native. If the RN app is not maintained, iOS dies quietly. Make that an explicit product decision at D1, not a side effect. |
| Security regressions in a reimplementation | Session revocation, attachment key scoping, block enforcement and SAS are server- or contract-defined. A native reimplementation that re-derives them is a vulnerability, not a port. |

## 11. What must not be claimed

- That the native app "adds system audio". Until D0 is green, nothing adds
  system audio, on either stack.
- That system audio, once shipped, works everywhere: playback capture is
  opt-out per source app (`ALLOW_CAPTURE_BY_NONE`) and never available for DRM
  audio ([decision record §6](./android-system-audio-decision.md#6-capture-is-never-universally-available)).
- That a rewrite improves call quality, reliability or latency. No measurement
  in this repository supports that; see `docs/media-connect-latency-diagnosis.md`
  and `docs/call-setup-telemetry-findings.md` for where call latency actually
  goes.

## 12. Verification note

The libwebrtc API facts in §3.1 **are** verified, mechanically, by
[`tools/webrtc-audio-probe`](../tools/webrtc-audio-probe/README.md) — 9/9 checks
passing against `org.jitsi:webrtc:124.0.0`. Re-run it on any WebRTC bump.

Everything else is desk analysis over this repository. Nothing in §4's D0.1–D0.4
is runtime-verified: CI has no Android device or emulator, and an API being
*shaped* to permit something is not evidence that it works. The line counts and
file counts in §1 and §6 were measured over `mobile/src` and `mobile/__tests__`
at the time of writing.
