# WeTalk UX Redesign — Implementation Status & Handoff

Working document for the multi-phase "Full UX Redesign" of the WeTalk Android
app. It records **what has shipped**, **where the work stops**, and **exactly
what the next session should do next**, in order.

All six planned phases (0–5) have now landed. What remains is listed in §3 and
is deliberately scoped: three feature-sized items that were cut from Phase 5, a
handful of unfinished Settings groups, and the on-device verification that unit
tests structurally cannot provide.

Read §1 for the shipped state, §2 for the exact stopping point, §3 for the
ordered next steps, and §4 for the traps that cost time the first time round.

---

## 0. How to work in this repo

All commands run from `mobile/`:

| Task | Command | Notes |
| --- | --- | --- |
| Install | `npm install` | `node_modules` is not checked in; required first. |
| Tests | `npx jest` | ~10 s warm. Current baseline: **95 suites / 1229 tests, all passing**. |
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
- **testIDs are load-bearing.** ~1229 tests assert on them. When a component
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

### Phase 5 — Polish & cross-cutting ✅ (three items deferred — see §2)

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

---

## 2. The exact stopping point

Everything above is committed on `copilot/ux-improvements-android-app` and green
at **95 suites / 1229 tests**, with `tsc` and `eslint` clean.

Four things are knowingly *not* done. None of them is a half-built control on
screen; each is either a feature-sized piece of work or a check a unit test
cannot make.

1. **Registration is still one dense form.** The planned split into (1) choose
   Google / Microsoft / email and (2) choose a username with live availability
   feedback was not attempted. It is a flow change with its own auth and
   validation surface, not a consistency fix.
2. **There is no first-run permissions primer.** Microphone / camera /
   notification access is still requested cold, and the only explanation is the
   startup degradation `Banner` shown *afterwards*. The `Banner` primitive that a
   primer would fall back to now exists, so the remaining work is the primer
   screen and its sequencing, not the banner.
3. **Dynamic type is not verified at 200%.** `fontScaleCaps` exists and the
   typography scale carries explicit line heights, but no pass has been made over
   list rows, bubbles and the control deck at maximum system font size. Jest
   cannot see truncation.
4. **The call canvas, PiP and CallKeep paths need on-device checks.** Unit tests
   cover the derivations (`mainHasVideo`, auto-hide gating, control-deck
   structure) but cannot verify what a real `RTCView`, a real PiP transition or a
   real CallKeep interaction does.

Two smaller gaps, recorded so they are not mistaken for oversights:

- **`SettingsScreen` is regrouped but not finished.** The original target had an
  identity card with the signed-in email plus focused editors behind `ListItem`
  rows; today the username and signaling-server fields are still inline
  `TextInput`s, and the **Storage & data** and **About** groups do not exist.
- **The Report affordance was removed rather than rebuilt.** There is no server
  report endpoint, so the row could only ever have shown an `Alert` promising an
  action nobody would take. Restoring it is a *backend* task first.

---

## 3. Ordered next steps

1. **Verify on a device.** Place an audio call and confirm the ambient canvas
   (not a black rectangle), background the app mid-call for PiP, and take a call
   through CallKeep from a locked screen. This is the highest-value remaining
   work because it is the only category the test suite structurally cannot reach.
2. **Run the 200% dynamic-type sweep.** Walk the chat list, a conversation with
   every bubble type, the call deck and Settings. Apply `fontScaleCaps` only
   where truncation would destroy meaning; prefer reflow over capping.
3. **Finish Settings**: identity card with the signed-in email, focused editors
   for the two remaining inline inputs, then the **Storage & data** (cache size,
   clear media, export logs) and **About** (version, licences) groups.
4. **Build the permissions primer** as a first-run step before the first request,
   with the existing startup `Banner` as the post-hoc fallback.
5. **Split registration into two steps**, keeping the current error/retry
   affordance intact.
6. **Re-verify AA contrast** for every semantic pairing introduced since Phase 0,
   including `ambient`/`onOverlay` on the audio canvas and each `Banner` tone.

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
