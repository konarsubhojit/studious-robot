# WeTalk UX Redesign — Implementation Status & Handoff

Working document for the multi-phase "Full UX Redesign" of the WeTalk Android
app. It records **what has shipped**, **where the work stops**, and **exactly
what the next session should do next**, in order.

All six planned phases (0–5) have landed, and so has Phase 6 — the four
deferred items from Phase 5 (Settings completion, permissions primer,
two-step registration, the dynamic-type and contrast sweep). What remains in §3
is only what a sandbox structurally cannot do: verification on real hardware.

Read §1 for the shipped state, §2 for the exact stopping point, §3 for the
ordered next steps, and §4 for the traps that cost time the first time round.

---

## 0. How to work in this repo

All commands run from `mobile/`:

| Task | Command | Notes |
| --- | --- | --- |
| Install | `npm install` | `node_modules` is not checked in; required first. |
| Tests | `npx jest` | ~10 s warm. Current baseline: **104 suites / 1349 tests, all passing**. |
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
- **testIDs are load-bearing.** ~1349 tests assert on them. When a component
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

---

## 2. The exact stopping point

Everything above is committed on `copilot/ux-improvements-android-app` and green
at **104 suites / 1349 tests**, with `tsc` and `eslint` clean.

**One thing is knowingly not done, and it cannot be done here:** the call
canvas, PiP and CallKeep paths have never been exercised on real hardware. Unit
tests cover every derivation around them — `mainHasVideo`, auto-hide gating,
control-deck structure, the PiP pan clamps — but cannot verify what a real
`RTCView` draws, what a real PiP transition does, or how a real CallKeep call
behaves from a locked screen. This is now the *only* remaining category of work,
and it is the highest-value one precisely because the suite structurally cannot
reach it.

Three limits are recorded so they are not mistaken for oversights:

- **Username availability is format-only.** The server exposes no
  unauthenticated availability check, so the registration screen cannot offer
  live "that name is taken" feedback. Adding it is a *backend* task first; the
  client-side rules are already in `registrationUx.ts` and would only need a
  debounced call bolted on.
- **The Report affordance was removed rather than rebuilt.** There is no server
  report endpoint, so the row could only ever have shown an `Alert` promising an
  action nobody would take. Also a backend task first.
- **`Toast` has no call site yet.** Its tones are now contrast-tested anyway, so
  the first surface to use it starts from a verified palette.

---

## 3. Ordered next steps

1. **Verify on a device.** Place an audio call and confirm the ambient canvas
   renders (not a black rectangle); background the app mid-call and watch the
   PiP transition; take a call through CallKeep from a locked screen. Then walk
   the same surfaces at 200% system font size to confirm the §1 Phase 6 caps and
   reflows behave — Jest asserts that a cap is *applied*, not that the result
   fits.
2. **Watch the primer's first run on a real Android device.** The ordering
   (primer explains → primer requests → `useStartupPermissions` stays out of the
   way) is unit-tested, but the thing worth seeing is whether the OS dialog
   arrives close enough behind the primer to read as one flow.
3. **Then, only if the backend grows the endpoints**: live username availability
   during registration, and the Report affordance.

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
