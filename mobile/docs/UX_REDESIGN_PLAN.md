# WeTalk UX Redesign — Implementation Status & Handoff

Working document for the multi-phase "Full UX Redesign" of the WeTalk Android
app. It records **what has shipped**, **where the work stops**, and **exactly
what the next session should do next**, in order.

All six planned phases (0–5) have landed, and so has Phase 6 — the four
deferred items from Phase 5 (Settings completion, permissions primer,
two-step registration, the dynamic-type and contrast sweep). What remains in §3
is only what a sandbox structurally cannot do: verification on real hardware.

Read §1 for the shipped state, §2 for the exact stopping point, §3 for the
device verification protocol that is now the only outstanding work, and §4 for
the traps that cost time the first time round.

`UI_REVAMP_TODO.md` in this directory is the older, superseded tracker from the
round before this one. Its two remaining open items are the same real-device QA
described in §3; treat §3 as the live list.

---

## 0. How to work in this repo

All commands run from `mobile/`:

| Task | Command | Notes |
| --- | --- | --- |
| Install | `npm install` | `node_modules` is not checked in; required first. |
| Tests | `npx jest` | ~10 s warm. Current baseline: **104 suites / 1354 tests, all passing**. |
| Types | `npx tsc --noEmit -p tsconfig.json` | Must be clean. |
| Lint | `npx eslint src/ __tests__/` | Must be clean. |

The trailing "A worker process has failed to exit gracefully" warning from Jest
is pre-existing and benign.

Non-negotiable constraints carried from the original plan:

- **Composition root holds.** Screens are presentational. State lives in
  `CallProvider` / `ChatProvider`. New screens are memoized renderers in
  `TabShell` plus routes in `AppNavigator` / `routes.ts` / `linking.ts`.
- **Narrow renderer deps.** `react-hooks/exhaustive-deps` counts `obj.method(...)`
  as using `obj`, so `TabShell` destructures context methods at component scope
  and lists the *members* in `useCallback` deps. Never depend on a whole context
  object — it reintroduces full-tree re-renders.
- **testIDs are load-bearing.** ~1354 tests assert on them. When a component
  survives in recognisable form its testIDs must survive too. Migrate tests
  alongside the component; never delete tests to make a phase green.
- **No colour literals under `src/components`.** `__tests__/components/designTokens.test.ts`
  walks the tree recursively and fails on any hex/rgb literal. To tint an `Icon`,
  read the colour back off a style (`StyleSheet.flatten(textStyle).color`), don't
  inline it.
- **`react-native-webrtc` cannot be imported by a unit-testable module.** It
  builds a `NativeEventEmitter` at module load and throws. Pure vocabulary
  (labels, defaults, formatters) belongs in `src/callUx.ts`, which is safe to
  import from anywhere. `src/callLog.ts` depends on it for exactly this reason.
- **`import type` is erased by Babel**, so a type-only import cannot drag a
  native module into a test.
- **Ship no dead controls.** Any affordance without real behaviour behind it is
  removed, not stubbed. This rule is why the Report row and the "Call
  notifications" toggle do not exist (§2).

---

## 1. What shipped

### Phase 0 — Foundation ✅

- `src/theme.ts`: semantic colour aliases in **both** palettes, `2xl`/`3xl`
  spacing, an `elevation()` shadow factory, `motion` tokens
  (`duration.{instant,fast,normal,slow}`, `delay.autoHide`,
  `spring.{gentle,lively}`), avatar/FAB size tokens, a full typography scale with
  explicit line heights (legacy aliases kept), `touchSlop(size)`, and
  `fontScaleCaps`.
- `src/vectorIcons.tsx`: ~35 semantic MaterialCommunityIcons keys. Emoji survive
  only on the font-not-linked fallback path.
- `src/components/primitives/`: **Icon, Avatar, Badge, Banner, Divider,
  SectionHeader, ListItem, SegmentedControl, Chip, Sheet, Toast, Skeleton
  (+ SkeletonRow), EmptyState, Switch, FAB, IconAction, Logotype**, barrelled
  through `primitives/index.ts`. Check real prop names there before use — e.g.
  `Avatar` is `{ id, size, online, loading, testID }` with **no** `presence`
  prop, and its status dot is `` `${testID}-status` `` rendered only when
  `online` is a boolean.
- `src/hooks/useReducedMotion.ts`: shared reduced-motion hook, now actually wired
  (Phase 5).

### Phase 1 — Information architecture ✅

- **`Lobby.tsx` (724 lines) deleted.** The dial form, "Your user ID" / "Callee
  user ID" inputs and the Call button are gone.
- **`src/components/CallsScreen.tsx`** is the Calls tab: full history,
  `All`/`Missed` `SegmentedControl` with a screen-reader announcement, rows
  grouped under date headings, peer avatar + direction glyph + media-type icon +
  time of day + duration. Tapping a row opens the person hub; the trailing button
  redials **in the original modality**.
- **`src/callLog.ts`**: pure, fully tested log derivations (`isMissedCall`,
  `callPeerId`, `callMediaType`, `callDirectionIcon`, `callMediaIcon`,
  `describeCallOutcome`, `formatCallTimeOfDay`, `formatCallDayHeading`,
  `filterCallLog`, `groupCallsByDay`, `describeCallEntryForA11y`).
- **`src/components/PeoplePickerSheet.tsx`** structurally replaces the dial form:
  directory search (300 ms debounce, stale-response guard) plus recents grouped
  by presence. Shared by the New-chat and New-call FABs.
- **Call modality persistence**: the server has no audio call type
  (`startAudioCallWith` places a video call and kills the camera), so intent is
  captured in `useCallFlow.outgoingCallMediaTypeRef`, stamped on the history entry
  at teardown, and persisted per-callId to `wetalk-call-media.json` (cap 200).
  Incoming calls default to `'video'`.
- **`ChatListScreen` rebuilt** on the primitives, including `SkeletonRow` loading.
- **`AppTabBar` rebuilt** and now badges **missed calls** on the Calls tab, not
  just chat unread.

### Phase 4 — Settings & person hub ✅

Landed out of numeric order because its groundwork was already on disk.

- **Notification preferences are enforced, not decorative.**
  `src/settingsStorage.ts` owns `NotificationPrefs` in its own
  `wetalk-notifications.json` (cap 500 muted peers) — deliberately *not* in
  `wetalk-settings.json`, because the push handler runs headless, before React
  exists, and must not need `useAppSettings`.
  `src/notificationPreferences.ts` is a synchronous in-memory cache over that
  file (`ensureNotificationPrefsLoaded`, `areMessageNotificationsEnabled`,
  `isPeerMuted`, `setPeerMuted`, `subscribeToNotificationPrefs`, …). Load
  failures fail **open**: silently swallowing every message would look like a
  broken app.
- `src/pushNotifications.ts` → `displayMessagePush` gained two suppressions with
  receipts, matching the existing `already_delivered` / on-screen shape:
  `notifications_disabled` and `peer_muted`.
- `useNotificationPreferences` → `ChatProvider` → `TabShell.renderPeerProfile`,
  so mute is a real per-person control.
- **`PeerProfileScreen` is the person hub**: `xl` `Avatar`, `IconAction` back,
  Message / Audio / Video actions, per-peer history via the shared `callLog.ts`
  helpers, shared media, mute, block.
- **`SettingsScreen` regrouped** into `SectionHeader`-led groups — Account,
  Notifications, Calls & media, Appearance, Privacy, Advanced — with **Sign out
  last and visually separated**. Privacy holds a real blocked-people list.
  (Storage & data and About were added in Phase 6.)

### Phase 2 — Chats & conversation ✅

`ChatConversationScreen.tsx` (~1750 lines, the highest-risk file in the
redesign) kept its behaviour and lost its divergences:

- **One bubble geometry** across text, image, video, voice, file, deleted and
  unsupported types.
- **One `DeliveryState`** affordance: queued / sent / delivered / read /
  failed-with-retry.
- **One notice stack**: reply preview, upload progress, offline and
  attachment-unavailable notices no longer each invent their own row.
- `AttachSheet` rebuilt on `Sheet` + `ListItem`; reaction chips on `Chip`.
- Reanimated gesture maths stayed worklet-safe through the move.

### Phase 3 — The call canvas ✅

- **Audio calls have their own canvas.** `deriveCallStreams` now also returns
  `mainHasVideo` (via a private `hasVideoTrack` that tolerates a missing or
  throwing `getVideoTracks`), because an audio call still produces a
  `MediaStream` with a playable URL — "is there a stream" cannot answer "is there
  a picture". `CallStage` renders `call-stage-ambient`: a large `Avatar`, the
  peer name in `typography.display`, and a status line, on the fixed-dark
  `ambient` token. The self-view PiP is suppressed. This also covers a video call
  where the remote peer turns their camera off.
- **The control deck has a hierarchy.** Primary row = mute / video / audio output
  / camera flip / **More**; screen share and screen audio moved into
  `call-more-sheet` as `ListItem` rows with `accessibilityRole="switch"`.
  `control-leave` never goes behind a sheet.
- **Auto-hide is contextual** and runs on `motion` tokens: never for audio-only
  calls, never while recovering, never while an error-severity status shows, and
  collapsed to `motion.duration.instant` under reduced motion.
- **Minimized surfaces agree.** `InCallBanner` gained mute/end, so banner, bubble
  and PiP each answer who, how long, and offer mute/end.

### Phase 5 — Polish & cross-cutting ✅ (four items deferred — closed by Phase 6)

- **A third status level exists.** `primitives/Banner.tsx` is the *persistent*
  surface between transient `Toast` and blocking `ErrorState`, with tones
  `neutral | warning | accent | negative`, an optional action and an optional
  dismiss. Its doc comment states the three-level rule so the next person doesn't
  have to infer it.
- **Four divergent offline/degraded treatments became one.** The conversation's
  local `Notice`, the `AppShell` startup-degradation `ErrorState`, the
  `CallsScreen` offline banner and the grey `search-degraded-note` text all
  render `Banner` now. `src/connectivityUx.ts` supplies one lead (`Offline`), one
  icon and one sentence shape, with only the *consequence* varying per surface.
- **Reduced motion is wired**, not merely available: the incoming/outgoing ring
  pulses hold at rest, and `FloatingCallBubble` assigns its snap target directly
  instead of springing (mirrored into a `useSharedValue`, because a worklet cannot
  read a plain JS boolean captured from render).
- **Outcomes are spoken.** `accessibilityAnnouncer.ts` gained
  `describeRecoveryState` and `describeMessageDelivery`; `AppShell` announces
  reconnect start/end and the conversation announces own-message sent/failed
  transitions (first sighting of a message is not announced, so entering a thread
  stays quiet).
- **Touch targets**: reaction chips derive `hitSlop` from `REACTION_CHIP_HEIGHT`
  rather than a guess, fixing a 50 dp effective target against the 56 dp minimum.

### Phase 6 — The four deferred items ✅

Everything §2 previously listed as knowingly-not-done, except the on-device
checks.

**Settings is finished.** The identity card now carries the signed-in account
(`src/accountUx.ts` turns a provider id + email into "Google · a@b.com", falling
back to "Signed in" when the provider is unknown). Both inline `TextInput`s are
gone: the username is a **read-only row**, because `useIdentity.updateUserId`
has always rejected every edit — usernames are bound to the account — so the
editor was a dead control by §0's rule; the signaling-server field moved into a
focused `Sheet` behind an Advanced row. Two new groups exist:

- **Storage & data** — `src/storageUsage.ts` walks the RNFS directories
  (deduplicated, because the platform can point two path constants at the same
  place) and splits the total into media / logs / data. `measureStorageUsage`
  distinguishes *unreadable* from *empty* via a `readable` flag, so a permission
  failure reports "Unavailable" rather than a confident "0 B" — but a single
  unreadable subdirectory does not poison its parent. `clearCachedMedia` skips
  files touched within `RECENT_FILE_GRACE_MS` (60 s) as probably in flight.
- **About** — `src/appInfo.ts` (version, platform) and `src/licenses.ts`, a
  checked-in table of 26 runtime dependencies with SPDX ids, shown in a `Sheet`.
  It is checked in rather than generated because the alternative is a build step
  that cannot run in a test.

**The permissions primer exists.** `PermissionsPrimerScreen` explains
microphone, camera and notifications *before* the first OS prompt, and
`wetalk-onboarding.json` records that it was seen so it never runs twice. The
important part is the sequencing: on Android the primer **owns** the cold
request, so `useStartupPermissions` is disabled there
(`{ enabled: !shouldShowPermissionPrimer() }`) — otherwise both would fire and
the primer would explain a dialog the user had already dismissed. On iOS
`shouldShowPermissionPrimer()` is `false` and the previous behaviour is
untouched. The startup `Banner` remains as the post-hoc fallback for a user who
skips.

**Registration is two steps.** `src/registrationUx.ts` holds the pure rules and
`RegistrationScreen` walks provider → username. Availability is validated
**client-side only** (3–32 characters, `[A-Za-z0-9._-]`, must start and end
alphanumeric): there is no unauthenticated availability endpoint — `GET /users`
is session-gated and `POST /session` only answers with a 409
`username_unavailable` on submit — so the screen promises format, not
uniqueness, and surfaces the collision on submit through the existing
error/retry affordance.

**Dynamic type and contrast were swept.** Nine texts gained a `fontScaleCap`,
each with a comment naming the container that cannot grow (a circle that must
stay circular, a bubble whose width is drag maths, a bottom-pinned deck that
would push **Leave** off-screen). Five places got *reflow* instead: the ambient
canvas name and the call-outcome pill wrap to two lines, `ListItem` titles wrap,
the presenter banner gained a `maxWidth`, and `Banner` dropped its two-line
clamp outright — a tall warning is a nuisance, a truncated one is a condition
the user never learns. `theme.ts` needed no new tokens. Contrast is now asserted
rather than assumed: `theme.test.ts` flattens every `Banner` and `Toast` tone
over `background` / `surfaceRaised` / `surface` in both palettes and checks 4.5:1
for text and 3:1 for the accent rule. **No token needed retuning**; the tightest
pairing is dark `danger` at 4.60:1.

### Swipe actions repaired 🐛

Reported from a device after Phase 6: swiping a message bubble would not let you
reply or delete. Two defects, both found by reading and neither visible to the
suite:

- **`SwipeableRow` measured its tray wrong.** Tray width was
  `actions.length * ACTION_WIDTH`, but each button also carries
  `marginLeft: spacing.xs`, so the open translation fell short by 4 dp per
  action. With the tray right-aligned, that clips `4 × (n − 1)` dp off the
  leftmost button's leading edge: nothing at one action, 4 dp at the
  Reply + Delete pair, 8 dp at three. `ACTION_SLOT_WIDTH` is now the single
  source of truth and is exported so the tests derive from it rather than
  restating `-84`.

  Worth being precise about, because it bounds the claim: 4 dp off an 84 dp
  button is a real misalignment but leaves 80 dp tappable, so **this defect
  alone does not explain "cannot reply or delete."** It is fixed on its own
  merits; the item below is the more plausible cause.
- **`removeClippedSubviews` was set on both lists that host a swipeable row.**
  On Android it clips by *layout* bounds and ignores `transform` — which is
  precisely how the tray is revealed — so a recycled row could become
  untouchable. Removed from `ChatConversationScreen` and `ChatListScreen`, with
  a comment at each site saying why it must not come back. The remaining
  virtualization props carry the performance intent.

Gesture arbitration was examined and deliberately left alone:
`activeOffsetX` + `failOffsetY` is the correct RNGH v3 mechanism, and adding
`simultaneousWithExternalGesture` or `blocksExternalGesture` on suspicion would
have been speculative. §3.6 is the check that closes this out.

### Theming becomes a personalisation surface ✅

Appearance was three radio buttons for System / Light / Dark, and the theme
around them was unfinished in ways only a device showed: a white flash on every
cold start, a status bar that told the truth only by accident, a `Toast`
primitive with no call site, and haptics silently wired to the OS *reduce
motion* setting.

- **The model is now preferences, not a mode.** `ThemePreferences`
  (`mode`, `contrast`, `accent`, `trueBlack`, `textScale`) is persisted per
  field in the same `wetalk-theme.json`, and a corrupt accent no longer resets
  the mode. `buildPalette(preferences)` derives every variant from the two base
  palettes, and is **memoised on the preference set** — `useThemedStyles` caches
  stylesheets in a `WeakMap` keyed on palette identity, so a freshly allocated
  palette per render would silently defeat the cache.
- **Four options ship, each with a real effect**: true black (offered only when
  the resolved scheme is dark, rather than shown disabled), high contrast
  (defaulting to the OS signal via `useHighContrast`, and *lowering* tint alpha
  — a stronger tint is the same hue as the tone on it, so it reduces contrast),
  five curated accents, and an in-app text scale that composes with the OS font
  scale instead of replacing it — capped at 1.3 because `fontScaleCaps` does
  *not* restrain it (that caps `maxFontSizeMultiplier`, and this changes the
  token's `fontSize` itself), so the fixed-height surfaces are protected only by
  the factor table staying modest. §3.4 is the check for it.
- **The guardrail is the cross-product.** `__tests__/theme.test.ts` builds every
  scheme × contrast × accent × true-black variant and asserts the token set is
  complete and the 4.5:1 / 3:1 rules hold, so a new accent cannot ship
  unchecked.
- **The flash is fixed natively**: `values/` and `values-night/` name a
  `windowBackground` matching `palettes.*.background`, so the window is already
  the right colour before React mounts, and `ThemeProvider` holds the first
  paint until the persisted preference resolves.
- **`Toast` has its first call site.** Transient settings confirmations (media
  cleared, server saved, unmuted, unblocked) are toasts; persistent conditions
  stay on `StatusBanner`, per the three-level rule in `Banner.tsx`.
- **Haptics left reduce motion.** Vibration is not motion on screen, and for
  some users it is the only confirmation a tap registered, so it is now an
  explicit *Haptic feedback* switch (default on) and `useReducedMotion` governs
  animation only — including the surfaces it had not reached yet (`Sheet`,
  `SwipeableRow`, `MediaViewer`, the PiP tile).

---

## 2. The exact stopping point

Everything above is committed on `copilot/ux-improvements-android-app` and green
at **104 suites / 1354 tests**, with `tsc` and `eslint` clean.

**One thing is knowingly not done, and it cannot be done here:** nothing in this
app has been exercised on real hardware. Unit tests cover every derivation —
`mainHasVideo`, auto-hide gating, control-deck structure, the PiP pan clamps,
the swipe tray geometry — but cannot verify what a real `RTCView` draws, what a
real PiP transition does, how a real CallKeep call behaves from a locked screen,
or whether a finger can reach a button. This is the *only* remaining category of
work, and §3 is now an executable protocol for it rather than an aspiration.

The swipe bug is the argument for taking §3 seriously: 104 green suites, `tsc`
and `eslint` all clean, and the feature was still unusable. The suite proved the
maths and could not have proved the rest.

Four limits are recorded so they are not mistaken for oversights:

- **The ambient call canvas is unreachable in practice.** `call-stage-ambient`
  is gated on the main stream having no video *track*, but nothing in the app
  ever produces that state: an "audio call" is a video call with the local
  camera toggled off, and `track.enabled = false` neither removes the track nor
  tells the peer anything. The UI is built, tokenised and unit-tested; the call
  setup simply never asks for it. Fixing it is a protocol change — camera-state
  signalling, or track removal plus renegotiation — which is why it is filed
  here and not in §3. Details and the corrected QA script are in §3.1.
- **Username availability is format-only.** The server exposes no
  unauthenticated availability check, so the registration screen cannot offer
  live "that name is taken" feedback. Adding it is a *backend* task first; the
  client-side rules are already in `registrationUx.ts` and would only need a
  debounced call bolted on.
- **The Report affordance was removed rather than rebuilt.** There is no server
  report endpoint, so the row could only ever have shown an `Alert` promising an
  action nobody would take. Also a backend task first.
- **The Android navigation bar cannot follow an in-app scheme.** It is tinted
  per OS scheme from `values-night/`, but React Native core exposes no runtime
  API for it and this app deliberately carries no navigation-bar dependency, so
  a user who pins the app to light on a dark phone keeps a dark navigation bar.
  See §3.7.5.

---

## 3. The device verification protocol

This is the whole of the remaining work. It is written as a protocol rather
than a wish because "verify on a device" is not a task anybody can pick up: it
has no pass criterion and leaves no artefact. Each check below names what to
do, what should happen, and **what evidence proves it happened** — so a
reviewer who was not holding the phone can still tell the difference between
"tested" and "looked at".

### 3.0 Capturing evidence

Every path in this section already logs its decisions, and **Settings → Storage
& data → Export logs** shares the buffer. So the evidence for each check is a
named log line, not a recollection.

Two things about that buffer decide whether the evidence survives:

- `logInfo` / `logWarn` / `logError` write to an **in-memory ring that dies with
  the process**. Only `logBackgroundInfo` / `logBackgroundWarn` /
  `logBackgroundError` append to `wetalk-background.log`.
  `getLogsForExport()` returns the memory buffer first, then the persisted file
  under a `--- persisted background logs ---` divider.
- CallKeep and Picture-in-Picture log through the **in-memory** helpers.
  **Export the logs before killing the app.** Force-stopping the app after a
  locked-screen test is the one action that destroys the evidence you just went
  to the trouble of producing.

Build with `npm run android` from `mobile/`. Two devices (or one device and one
emulator) are needed for every call check; the emulator can be the peer.

### 3.1 The call canvas — `mainHasVideo`

The derivation is unit-tested; what is unverified is that it drives a real
`RTCView`. The failure mode is not a crash — it is a **black rectangle** where a
picture or the ambient canvas should be.

**Read this before writing up a defect.** `call-stage-ambient` is gated on the
main stream having no video *track*:
`isAudioOnly = Boolean(mainStream) && !mainHasVideo`, where `mainHasVideo` is
`getVideoTracks().length > 0` (`callStreamHelpers.ts`). Turning a camera off does
**not** remove a track — it sets `track.enabled = false`, and a disabled sender
still transmits, so the receiver keeps a video track. An "audio call" in this app
is also not audio-only on the wire: `startAudioCallWith` places a normal video
call and toggles the local camera off once connected (`useCallInitiation.ts`),
`getUserMedia` always requests video with no audio-only fallback, and the callee
is never told the call was meant to be audio.

So on today's code the ambient canvas is **not** reachable by either route, and a
tester following the obvious script would file a false defect against it. What to
actually check:

1. Place an **audio** call from the Calls tab. Expect the stage to render video
   (the peer is still sending it) — *not* `call-stage-ambient`. Confirm it draws
   a picture rather than a black rectangle: that is the `RTCView` claim this
   check exists to test.
2. Have the peer disable their camera mid-call. Expect the stage to hold the last
   decoded frame or go black — again **not** ambient.
3. If you can reach ambient at all — a peer on a client that genuinely omits the
   video track — confirm it renders a large avatar, the peer's name in
   `typography.display`, a status line on the fixed-dark `ambient` token, and
   **no** self-view PiP.

**This is a real product gap, not a documentation one**, and it is why §3.1 reads
oddly: the ambient canvas was built and unit-tested for a state the call setup
never produces. Closing it means either making `hasVideoTrack` consider
`track.enabled`/`muted` — which needs camera-state signalling, since `enabled` is
a local flag the peer cannot observe — or removing the track and renegotiating.
Both are protocol changes, so both are §2 work rather than a QA fix. The stale
comments at `AppShell.tsx` (`isAudioOnly`) and `callStreamHelpers.ts`
(`hasVideoTrack`) both assert the camera-off case works; they were left in place
so this note and the code disagree loudly rather than quietly.

### 3.2 Picture-in-Picture

1. With a video call connected, press Home.
2. Expect the PiP window, with its **mute** and **hang up** controls.
   Evidence: `Picture-in-Picture mode entered`.
3. Tap each PiP control and confirm the call reacts.
4. Return to the app, then **end the call while still in PiP** (background the
   app again, then have the peer hang up). The window must disappear with the
   call. `stopCallService` calls `exitPictureInPicture` for exactly this reason;
   without it the window survives showing the last decoded frame of a closed
   peer connection.

Failure evidence to look for: `Picture-in-Picture mode was refused by the
activity` (the OS declined — check the activity's PiP configuration), or
`Picture-in-Picture request skipped` with `reason: 'unsupported'` (no native
module) or a `sinceLastRequestMs` under 1000 (the 1 s dedupe window absorbed a
duplicate request, which is working as intended and not a fault).

### 3.3 CallKeep from a locked screen

This is the highest-risk check in the document, because it exercises the one
race the architecture is explicitly built around: an incoming call can be
**answered before any React component has mounted**. `registerCallActionListeners`
subscribes at module scope from `initObservability()` in `index.tsx` precisely so
the listener exists in the headless JS context a push cold-starts, and
`recordPendingAnswer` queues the tap for replay when no call flow is attached
yet.

1. Force-stop the app, lock the device.
2. Call it from the peer. Expect the system call UI.
3. **Answer from the lock screen.**
4. Expect the app to come to the foreground already in the connected call — not
   on the chat list, and not on a ringing screen for a call that was already
   accepted.
5. Export the logs **without force-stopping**.

The evidence is a sequence, and which sequence you get tells you which path ran:

- `[CallKeep] answerCall` — the tap reached JS at all.
- `[CallKeep] answerCall received with no call flow attached; queuing for replay`
  followed by `[CallKeep] Pending answer drained` — the cold-start race happened
  **and the queue absorbed it.** This is the good outcome, and the one worth
  deliberately provoking.
- `[CallKeep] Pending answer dropped` — the tap was lost. This is the bug this
  machinery exists to prevent; capture the surrounding lines and the `reason`.

Also confirm the negative case: if the startup `Banner` reports a degradation on
launch, CallKeep never initialised and the rest of this check is meaningless.
`callKeepActions` and `callKeepIncomingUi` are the two degradation ids to look
for, and they are visible in the UI without reading a log at all.

### 3.4 Dynamic type at 200%

Jest asserts that a cap is *applied*; only a screen can show whether the result
fits. Set the system font size to maximum and walk:

- the chat list, and a conversation containing **every** bubble type (text,
  image, video, voice, file, deleted, unsupported) plus a reply quote and a
  reaction row;
- the call deck — the check that matters is that **`control-leave` is still
  fully on screen**, since the deck is bottom-pinned and does not scroll;
- the minimized surfaces: `FloatingCallBubble` must stay draggable and fully
  on-screen (its width is drag maths, not decoration) and `InCallBanner` must
  still show who and how long;
- Settings, including the two `Sheet`s (signaling editor, licences), because a
  sheet's list is capped at `sizes.sheetListMaxHeight`.

Then repeat the same walk with **Settings › Appearance › Text size** at
**Larger**, at both the default and the maximum system font size. This step is
not redundant: the in-app scale multiplies the token `fontSize`, which
`maxFontSizeMultiplier` does not bound, so it is the only one of the two that
can overflow a capped label. The bottom-pinned call deck is again the check
that matters.

Expect wrapping, never truncation, in running text, and expect capped text to
stay on one line — `maxFontSizeMultiplier={fontScaleCaps.*}` marks all 17 of
them, nine of which the Phase 6 sweep added. A capped text that still overflows
means the cap was applied to the wrong element.

### 3.5 The permissions primer, first run

Only reproducible on a genuinely fresh install, since the outcome is persisted.

1. Uninstall, reinstall, launch, sign in.
2. Expect the primer **before** any OS dialog.
3. Accept, and confirm the OS prompts follow immediately enough to read as one
   flow. This is a judgement only a person can make, and it is the entire reason
   the primer exists.
4. Reinstall and repeat, but **skip** the primer. Expect the startup `Banner` to
   state the consequence afterwards, and expect the primer not to return on the
   next launch.
5. Confirm the primer never appears over the sign-in screen or over a ringing
   call — both are asserted in `AppShell.test.tsx`, so a failure here means the
   routing changed underneath those tests.

### 3.6 Swipe actions on a message and a conversation row

Added after a user reported being unable to reply to or delete a message on
device while all 104 suites were green — see the `SwipeableRow` entry in §4.
Two defects were found by reading and fixed; **neither is reproducible in Jest**,
so this check is what closes them out.

1. In a conversation, swipe one of **your own** messages left. Expect a tray of
   **Reply** and **Delete**, both fully revealed — the previous bug left the
   leftmost action partly under the row, so confirm the whole button is visible
   and not merely most of it.
2. Tap **Reply**; the composer must quote that message. Swipe again, tap
   **Delete**; expect the confirmation, then a tombstone.
3. Swipe a message from the **peer**. Expect **Reply** only — delete is never
   offered for someone else's message, because the server refuses it.
4. Swipe a **failed** own message. Expect **Retry** alongside the others.
5. Repeat on a tombstone: expect **no** tray at all.
6. Scroll the list hard, then swipe a row that has just been recycled into view.
   This is the case `removeClippedSubviews` used to break, so it is the one most
   worth repeating.
7. Do the same on the Chats tab: swipe a conversation with unread messages and
   expect **Mark read**.
8. With TalkBack on, confirm each action is reachable as an accessibility action
   without performing the drag.

**If it is still broken, do not re-fix the two defects above — they are bounded
and verified by reading.** Narrow it instead, cheapest first:

- **Does the row move at all?** If the bubble does not track the finger, the
  gesture never activates and the tray is irrelevant: suspect arbitration with
  the `FlatList`, not geometry. If the row moves but the buttons do nothing, the
  gesture is fine and the problem is touch dispatch.
- If dispatch is the half that fails, the next suspect is Android hit-testing of
  a *transformed* view: the tray is a static sibling and the row slides over it,
  so a build that hit-tests the row at its untransformed position would swallow
  every tap on a revealed button while still animating perfectly. Test it by
  temporarily giving `styles.row` a translucent background — if the buttons are
  visible underneath and still dead, it is dispatch, not layout.
- Only then consider `simultaneousWithExternalGesture` / `blocksExternalGesture`.
  Note the shared mock in `__mocks__/react-native-gesture-handler.js` implements
  a fixed method list, so using either one means extending the mock or every
  suite that renders a row fails at once.

Record which of these it was in §4, because the next person will not be able to
reproduce it from the suite either.

### 3.7 Theming: the cold-start flash and the system bars

The two defects the theme personalisation work fixed that **no Jest run can
observe**, because both happen before or outside React. A unit test asserts only
that the resource files still name the palette colours
(`__tests__/androidWindowBackground.test.ts`); whether the frame that reaches
the screen is the right colour is a device question.

1. **The flash.** Put the device in dark mode, force-stop the app, then cold
   launch it while watching the very first frame — record the screen at 60fps if
   your eye disagrees with itself twice. Expect the window to come up already
   dark. A white frame between the launcher and the first React render means
   `values-night/colors.xml` did not resolve; capture the frame as the evidence.
2. Repeat in light mode. The complementary failure (a dark flash before a light
   app) is the one that survives when only the night variant is added.
3. **The status bar.** In each scheme, confirm the bar is the same colour as the
   screen behind it and that its icons are legible — expect no visible seam at
   the top of the chat list.
4. Turn on **True black** and then **High contrast** in Settings › Appearance.
   The status bar must follow, because it is driven from the palette rather than
   from the scheme name. This is also the check that catches a palette variant
   that forgot a token: log `theme.colors.background` alongside a screenshot.
5. **The one known limitation:** with the app pinned to a scheme that differs
   from the OS (light app on a dark phone, or the reverse), the *navigation* bar
   still follows the OS. React Native core exposes no API for it and this app
   deliberately carries no navigation-bar dependency, so `values-night/` is the
   only lever. Record it as observed, not as a regression.
6. **The full-screen call.** Place a call from a *light*-scheme device. The
   status bar must go dark for the duration — the video stage is fixed-dark in
   both schemes, so a light bar would sit on top of black video — and must
   return to the light background when the call ends.
7. **Haptics vs. reduced motion.** Turn the OS "Remove animations" setting on.
   Expect call-control taps to **still** vibrate (they no longer share a switch
   with animation), and expect Settings › Calls & media › Haptic feedback to be
   the only thing that silences them. Then check the animated surfaces in the
   same pass: sheets appear without a fade, a swiped row snaps to its open
   position, the PiP tile parks against the edge without gliding, and the
   skeleton stops shimmering — in every case the *end state* must still be
   reached.

### 3.8 Then, and only if the backend grows the endpoints

Live username availability during registration, and the Report affordance. Both
are blocked on server work, not client work — see §2.

---

## 4. Gotchas worth not rediscovering

- **`Sheet` must not call `useSafeAreaInsets()`** — it throws "No safe area value
  available" without a provider. It reads `SafeAreaInsetsContext` via
  `useContext` instead (`null` when absent). Elsewhere insets are read only at
  shell level (`AppShell`, `TabShell`) and passed down as numbers.
- **Pressing vs. asserting in `react-test-renderer`.** A host node carries
  `testID` and `accessibilityState` but *not* `onPress`; the composite carries
  `onPress`. To press, find the node where `typeof n.props?.onPress === 'function'`.
  To count rows or read rendered accessibility attributes, filter
  `typeof n.type === 'string'`.
- **A component that takes `testID` as a prop matches a naive `testID` search on
  its own composite**, which carries none of the rendered attributes. `Banner`'s
  suite keeps a host-only `findByTestId` for this reason.
- **`Banner` and `ErrorState` derive child testIDs** as `` `${testID}-action` ``
  and `` `${testID}-dismiss` ``. `Banner` had to adopt `ErrorState`'s derivation
  so the `CallsScreen` and `AppShell` suites survived the swap.
- **A composite returning `null` still appears in `tree.root.findAll`** with its
  props — assert "renders nothing" against a *host* node, not the component's own
  testID.
- **`theme.test.ts` invariant**: `Object.keys(palettes.light).sort()` must equal
  `Object.keys(palettes.dark).sort()`. `ambient` is fixed-dark in both schemes,
  so it must **not** be added to the `SURFACES` list.
- **Reanimated worklets cannot read a plain JS boolean captured from render.**
  Mirror it into a `useSharedValue` first — that is how reduced motion reaches
  `FloatingCallBubble`'s pan handler.
- **Beware regex-driven edits in `ChatConversationScreen.tsx`.** An unscoped
  `styles={styles}` removal during the `Notice` → `Banner` swap silently stripped
  the prop from four unrelated components. Scope such edits to a substring, and
  re-read the diff.
- **`mobile/__mocks__/react-native-fs.js`** is picked up automatically, so suites
  no longer need their own `jest.mock('react-native-fs', …)`. Explicit per-suite
  factories still win.
- **`AppSettingsValues` field names** are `autoCameraLightingEnabled` and
  `speakerEnabledByDefault` (not `autoLighting` / `speakerDefault`).
- **`mergeSettings` in `settingsStorage.ts`** keeps only keys whose `typeof`
  matches the default's; arrays survive because `typeof [] === 'object'`.
- **Deep links are load-bearing.** Any route rename must be reflected in
  `linking.ts` and reconciled with persisted navigation state, or a cold start
  after an update lands nowhere.
- **There is no reactive audio-only flag on `CallProvider`.**
  `useCallFlow.outgoingCallMediaTypeRef` is a ref, read only when recording
  history; making it reactive means surgery on a ~3900-line hook. Derive from
  `mainHasVideo` instead.
- **A testID can be duplicated into two sections and every suite stays green.**
  Code review, not Jest, caught an `Export logs` row rendered in *both* Storage
  & data and Advanced. `findAll` happily returns two nodes and
  `findAll(...)[0].props.onPress()` still fires, so the assertions passed while
  the user saw the control twice. When a row is conditional on a prop, assert
  the host-node **count**, not merely its presence.
- **A test can pass for the bug it is named after and still assert nothing.**
  The first attempt at a regression test for the swipe tray pressed each action
  by `testID` and checked its callback fired. It passes identically against the
  *broken* arithmetic, because pressing a node by testID involves no layout,
  translation or hit-testing. If a test would pass with the fix reverted, it is
  documentation, not a test — revert the fix and watch it fail before believing
  it. What does hold the line here is geometric: `test.each([1,2,3])` deriving
  the expected translation from `ACTION_SLOT_WIDTH`, plus a check that the
  rendered style's `width + marginLeft` sums to that same constant.
- **A unit-tested surface can be unreachable in the running app.** The ambient
  call canvas is fully built, tokenised and covered, and no call the app can
  place will ever show it — `mainHasVideo` asks whether a video *track* exists,
  while "camera off" only sets `track.enabled = false`. Tests pinned the
  derivation, not the premise, so nothing went red. When a component's gate is
  fed by a value the tests supply directly, check who supplies it in production
  before trusting the coverage. See §3.1.
- **A green suite is not evidence for anything gesture-driven.**
  `mobile/__mocks__/react-native-gesture-handler.js` stubs `GestureDetector` as
  `({ children }) => children` and only records the gesture callbacks, so tests
  drive the *maths* of a swipe and never its touch dispatch, layout or
  arbitration with the parent list. Geometry belongs in a test; whether a finger
  can reach the button does not. Derive any geometry assertion from the same
  constant the component uses, or the two drift and the test still passes.
- **A partial `jest.mock` of `src/permissions` breaks the moment a module
  imports something new from it.** Several suites mock it with an object
  literal, so `getMissingRuntimePermissions` had to be added to
  `useCallFlow.test.tsx`'s factory. Extend the mock — never add a defensive
  `typeof fn === 'function'` guard in production code to satisfy a test.
- **`useIdentity.updateUserId` always rejects.** Usernames are bound to the
  account, so anything that looks like a username editor is a dead control.
- **Filtering `typeof n.type !== 'string'` matches two nodes per row**, because
  RN's own `View` is also a composite. To find one component instance, match on
  something only it has (`typeof n.type === 'function' && typeof n.props?.subtitle === 'string'`).
- **`ListItem` renders a plain `View` when it has no `onPress`.** A read-only
  row therefore needs its accessibility props applied on that branch too, and
  the default `button` role mapped to `text` — a row with no handler has no
  business claiming to be a button.
- **`Sheet`'s close prop is `onClose`, not `onDismiss`**, and `Icon` names must
  already exist in `ICONS` in `vectorIcons.tsx` — an unknown key renders
  nothing rather than failing loudly.
- **Never `git stash` while another agent writes the same tree.** A stash taken
  just before an external commit lands leaves the commit missing those changes.
  Prefer targeted edits over whole-file rewrites on shared files for the same
  reason.
