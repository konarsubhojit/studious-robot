# WeTalk UX Redesign — Implementation Status & Handoff

Working document for the multi-phase "Full UX Redesign" of the WeTalk Android
app. It records **what has shipped**, **what is half-built and where it stops**,
and **exactly what the next session should do next**, in order.

Read §1 for state, §2 for the immediate next task (it has an in-flight change on
disk), then §3-§6 for the remaining phases.

---

## 0. How to work in this repo

All commands run from `mobile/`:

| Task | Command | Notes |
| --- | --- | --- |
| Install | `npm install` | `node_modules` is not checked in; required first. |
| Tests | `npx jest` | ~5-8 min for the full suite. Current baseline: **90 suites / 1141 tests, all passing**. |
| Types | `npx tsc --noEmit -p tsconfig.json` | Must be clean. |
| Lint | `npx eslint src/ __tests__/` | Must be clean. |

Non-negotiable constraints carried from the plan:

- **Composition root holds.** Screens are presentational. State lives in
  `CallProvider` / `ChatProvider`. New screens are memoized renderers in
  `TabShell` plus routes in `AppNavigator` / `routes.ts` / `linking.ts`.
- **Narrow renderer deps.** `react-hooks/exhaustive-deps` counts `obj.method(...)`
  as using `obj`, so `TabShell` destructures context methods at component scope
  and lists the *members* in `useCallback` deps. Never depend on a whole context
  object — it reintroduces full-tree re-renders.
- **testIDs are load-bearing.** ~1141 tests assert on them. When a component
  survives in recognisable form its testIDs must survive too. Migrate tests
  alongside the component; never delete tests to make a phase green.
- **No colour literals under `src/components`.** `__tests__/components/designTokens.test.ts`
  walks the tree recursively and fails on any hex/rgb literal. To tint an `Icon`,
  read the colour back off a style (`styles.timestamp.color`), don't inline it.
- **`react-native-webrtc` cannot be imported by a unit-testable module.** It
  builds a `NativeEventEmitter` at module load and throws. Pure vocabulary
  (labels, defaults, formatters) belongs in `src/callUx.ts`, which is safe to
  import from anywhere. `src/callLog.ts` depends on it for exactly this reason.
- **`import type` is erased by Babel**, so a type-only import cannot drag a
  native module into a test.

---

## 1. Status by phase

### Phase 0 — Foundation ✅ shipped

- `src/theme.ts`: semantic colour aliases in **both** palettes, `2xl`/`3xl`
  spacing, an `elevation()` shadow factory, `motion` tokens (durations +
  easings), avatar/FAB size tokens, a full typography scale with explicit line
  heights (legacy aliases kept), and `fontScaleCaps`.
- `src/vectorIcons.tsx`: ~35 new semantic MaterialCommunityIcons keys (back,
  search, new-chat, new-call, filter, block, report, media, storage, about, …).
  Emoji survive only on the font-not-linked fallback path.
- `src/components/primitives/`: **Icon, Avatar, Badge, Divider, SectionHeader,
  ListItem, SegmentedControl, Chip, Sheet, Toast, Skeleton (+ SkeletonRow),
  EmptyState, Switch, FAB, IconAction, Logotype**, barrelled through
  `primitives/index.ts`. Check real prop names there before use — e.g. `Avatar`
  is `{ id, size, online, loading, testID }` with **no** `presence` prop, and
  its status dot is `` `${testID}-status` `` rendered only when `online` is a
  boolean.
- `src/hooks/useReducedMotion.ts`: shared reduced-motion hook (generalised from
  the detection previously buried in `haptics.ts`). **Built but not yet wired to
  most animations** — see Phase 5.
- Emoji-as-icon retired across `SettingsScreen`, `PeerProfileScreen`,
  `SearchScreen`, `ChatConversationScreen`, `MediaViewer`, `InCallBanner`,
  `FloatingCallBubble`, `CallTimelineRow`, `RegistrationScreen`. The 📞 app mark
  is now the drawn `Logotype`.

### Phase 1 — Information architecture ✅ shipped

- **`Lobby.tsx` (724 lines) deleted**, along with its test file. The dial form,
  "Your user ID" / "Callee user ID" inputs and the Call button are gone.
- **`src/components/CallsScreen.tsx`** is the new Calls tab: full history (not
  five rows), `All`/`Missed` `SegmentedControl` with a screen-reader
  announcement, rows grouped under date headings, peer avatar + direction glyph
  + audio/video type icon + time of day + duration. Tapping a row opens the
  person hub; the trailing button redials **in the original modality**.
  testIDs: `calls-root`, `calls-filter`, `calls-open-search`, `calls-new-call`,
  `calls-empty`, `calls-loading`, `calls-people-picker`, `calls-modality-sheet`,
  `calls-modality-audio`, `calls-modality-video`, plus preserved
  `call-history-section`, `call-history-row`, `call-history-redial`,
  `offline-banner`.
- **`src/callLog.ts`**: pure, fully tested log derivations — `isMissedCall`,
  `callPeerId`, `callMediaType`, `callDirectionIcon`, `callMediaIcon`,
  `describeCallOutcome`, `formatCallTimeOfDay`, `formatCallDayHeading`,
  `filterCallLog`, `groupCallsByDay`, `describeCallEntryForA11y`. 24 tests.
- **`src/components/PeoplePickerSheet.tsx`**: the component that structurally
  replaces the dial form. Directory search (300 ms debounce, stale-response
  guard) plus recents grouped by presence. Shared by the New-chat and New-call
  FABs. 8 tests.
- **Call modality persistence**: the server has no audio call type
  (`startAudioCallWith` places a video call and kills the camera), so intent is
  captured in `useCallFlow.outgoingCallMediaTypeRef`, stamped on the history
  entry at teardown, and persisted per-callId to `wetalk-call-media.json`
  (cap 200). Incoming calls default to `'video'`.
- **`ChatListScreen` rebuilt** on the primitives. Inline search field, the ⚙️
  gear, `ClearableInput` and all search-mode state deleted. New props
  `onOpenProfile` / `onStartChat` / `currentUserId`, a New-chat FAB, and a real
  first-run `EmptyState` that opens the People picker.
- **`AppTabBar` rebuilt** on the primitives and now badges **missed calls on the
  Calls tab**, not just chat unread.
- Speaker-by-default and auto camera lighting moved out of the deleted Lobby
  developer panel into a new Settings → "Calls & media" section
  (`settings-speaker-default`, `settings-auto-lighting`). Dead
  `isSettingsVisible` state removed from `useAppSettings` and `CallProvider`.
  Stale "Join Room / room ID" copy deleted.

### Phase 4 — Settings & person hub 🚧 **in progress — groundwork only**

Two files landed as *unwired groundwork*. They compile, lint and break nothing,
but **nothing imports them yet**:

- `src/settingsStorage.ts` — appended `NotificationPrefs`,
  `DEFAULT_NOTIFICATION_PREFS`, `loadNotificationPrefs`,
  `saveNotificationPrefs`, `NOTIFICATION_FILE_PATH`, backed by
  `wetalk-notifications.json` (cap 500 muted peers). Kept out of
  `wetalk-settings.json` deliberately: the push handler runs headless, before
  React exists, so it must not need `useAppSettings`.
- `src/notificationPreferences.ts` — **new**. An in-memory cache over that file
  so the push path can decide *synchronously*:
  `ensureNotificationPrefsLoaded()` (idempotent, shared in-flight promise),
  `getNotificationPrefs()`, `areMessageNotificationsEnabled()`,
  `isPeerMuted(peerId)` (case/whitespace-normalised),
  `setMessageNotificationsEnabled()`, `setPeerMuted()`,
  `subscribeToNotificationPrefs()`, `resetNotificationPrefsForTests()`.
  Load failures fail **open** (notifications on) — silently swallowing every
  message would look like a broken app.

### Phases 2, 3, 5 — not started

---

## 2. Next task: finish Phase 4

Do these in order; each step is independently verifiable.

### 2.1 Wire the mute decision into the push path

`src/pushNotifications.ts` → `displayMessagePush(...)` (~line 556). It already
suppresses in two cases, each with a receipt: `already_delivered` (via
`hasSeenMessage`) and the on-screen-conversation case (via
`isConversationOnScreen`, ~line 582). Add a third suppression **immediately
after** the on-screen check, following the identical shape — call
`sendPushReceipt` with `stage: 'notification_suppressed'` and return
`{ shown: false, reason }`:

- `reason: 'notifications_disabled'` when `!areMessageNotificationsEnabled()`
- `reason: 'peer_muted'` when `isPeerMuted(message.senderId)`

Await `ensureNotificationPrefsLoaded()` before reading, since the background
handler may be the first thing to run in the process. Mirror the same checks in
the foreground handler if it does not funnel through `displayMessagePush`.

**Scope decision already taken:** ship only two *enforced* preferences —
**Message notifications** (global) and **Muted people** (per-person). Do **not**
add a "Call notifications" toggle: suppressing incoming-call notifications risks
silently dropping calls and would be another affordance that does not fully
work. The whole point of this phase is to stop shipping dead controls.

### 2.2 Surface mute through the provider

Add a `useNotificationPreferences` hook (subscribe via
`subscribeToNotificationPrefs`, hydrate via `ensureNotificationPrefsLoaded`) and
expose `mutedPeers` / `isPeerMuted` / `setPeerMuted` /
`messageNotificationsEnabled` / `setMessageNotificationsEnabled` through
`ChatProvider` — mute is a person/chat concern, and blocking already surfaces
there (`isUserBlocked` / `blockPeer` / `unblockPeer`, `ChatProvider.tsx:36-38`,
`121-123`; implemented in `useCallFlow.ts:2723-2742` over `useBlocks`).

Then wire `TabShell.renderPeerProfile` (~line 204) to pass `isMuted` and
`onToggleMute`, keeping deps narrow.

### 2.3 Rebuild `PeerProfileScreen` as the person hub

`src/components/PeerProfileScreen.tsx` (343 lines). Target shape: large `Avatar`
(`size="xl"`, presence dot) replacing the hand-rolled `avatarCircle`/`avatarText`
(lines 145-155, 275-286); `IconAction` back button; primary Message / Audio /
Video actions; per-peer call history rendered with `ListItem` + `SectionHeader`
**using the shared `callLog.ts` helpers** instead of the local `describeCall` /
`formatTimestamp` that duplicate them; shared media; mute; block; report.

- **Mute** becomes real via §2.2 — no longer conditional on a prop nobody passes
  (currently lines 206-219).
- **Report** currently falls back to a stub `Alert.alert` (line 126). Either
  wire it to real behaviour or remove the row. Do not ship the stub.
- Preserve every testID: `peer-profile-root`, `peer-profile-back`,
  `peer-profile-presence`, `peer-profile-blocked-note`, `peer-profile-message`,
  `peer-profile-audio-call`, `peer-profile-video-call`, `peer-profile-no-calls`,
  `peer-profile-call-row`, `peer-profile-mute`, `peer-profile-block`,
  `peer-profile-report`.

Every person-shaped tap in the app should route here.

### 2.4 Regroup `SettingsScreen`

`src/components/SettingsScreen.tsx` (~490 lines). Replace the column of bare
TextInput+Save pairs with an identity card (avatar, username, presence,
signed-in email) followed by grouped `ListItem` rows opening focused editors:

**Account · Notifications · Calls & media · Appearance · Privacy · Storage &
data · Advanced · About**, with **Sign out last and visually separated**.

- Notifications: the global message-notifications `Switch` plus a "Muted people"
  list driven by §2.2.
- Privacy: a **real blocked-people list** (read `blockedUsers` from the
  provider; unblock in place).
- Calls & media: already holds speaker-default and auto-lighting — keep them.
- Advanced: signaling server, ICE policy, export logs, developer mode.

### 2.5 Tests, then commit

Add `__tests__/notificationPreferences.test.ts` (hydration is idempotent, load
failure fails open, mute normalisation, subscriber fan-out, a `setPeerMuted`
during an in-flight load wins over the file) and push-path suppression tests;
extend the person-hub and settings suites. Then `npx tsc --noEmit`,
`npx eslint src/ __tests__/`, `npx jest`, `runtime-tools-secret_scanning`,
`engine-tools-report_progress`.

---

## 3. Phase 2 — Chats & conversation

- **Chat list**: already rebuilt in Phase 1. Remaining: promote the bespoke
  loading state fully onto the shared `Skeleton` primitive.
- **Conversation** (`ChatConversationScreen.tsx`, **1782 lines — the highest-risk
  file in the redesign**). Keep the behaviour, restructure the chrome:
  - Header → avatar + name + presence/typing subtitle + audio/video actions.
  - **One bubble geometry** across text, image, video, voice, file, deleted and
    unsupported types (they currently diverge).
  - **One delivery-state affordance**: queued / sent / delivered / read /
    failed-with-retry.
  - Reply preview, upload progress, offline notice and attachment-unavailable
    notice collapse from four bespoke rows into **one stack of consistent inline
    banners**.
  - Reaction chips, the reaction bar and the attach sheet move onto the shared
    `Chip` / `Sheet` primitives.
  - Scroll-to-bottom control becomes a real `FAB` carrying the unread count.
  - Reanimated gesture maths (bubble, swipe rows, media viewer) must stay
    **worklet-safe** as it moves into shared primitives.

---

## 4. Phase 3 — The call canvas

Merge outgoing / incoming / connected / minimized / PiP — today five separately
designed surfaces — into **one canvas** where the same avatar, title block and
control-deck geometry persist while the state changes around them:

- `outgoing → ringing → connecting → connected → reconnecting → ended` as
  transitions on one canvas, not screen swaps.
- **Audio calls get their own treatment**: large avatar on an ambient background
  (the `ambient` token already exists and is fixed-dark in both schemes, like
  `stage`, so its foreground is `onOverlay`). Replaces today's empty black video
  stage.
- **Control-deck hierarchy**: primary row (mute, camera, audio output, flip) +
  a "More" sheet for screen share, screen audio, diagnostics. End-call keeps its
  own distinct, always-visible position.
- **Contextual chrome auto-hide**: never for audio-only calls, never while a
  reconnect banner or error shows, and honour reduced motion. The 180 ms/3000 ms
  literals in `CallScreen` become the shared `motion` tokens.
- **Minimized hierarchy**: in-app banner (always present, not dismissible) →
  draggable bubble (dismissible) → OS PiP (backgrounded). Each shows who, how
  long, and offers mute/end consistently.
- **Call end** produces an outcome in context: a `CallTimelineRow` entry in the
  conversation and an accurate call-log row, with an optional quality prompt.
- Needs **on-device checks** for the canvas, PiP and CallKeep paths — unit tests
  cannot cover them.

---

## 5. Phase 5 — Polish & cross-cutting

- **Status levels, used consistently**: transient → `Toast`; persistent → inline
  banner (offline, reconnecting, degraded permissions); blocking → full
  `ErrorState` with a next action. `StatusBanner` is currently used for both
  transient and persistent messages. Give the `AppShell` startup-degradation
  banner the same treatment as every other banner.
- **One offline representation** in the same place on every screen, wired to
  `networkMonitor` + server-unreachable state, replacing the per-screen variants
  ("Server unreachable", "Offline — showing conversations stored on this
  device", and the conversation's own offline flag).
- **Permissions**: replace the startup "Calling may not work reliably" banner
  with a first-run primer that explains microphone/camera/notification use
  *before* requesting, plus a dismissible-per-session inline banner afterwards.
- **Registration**: split the dense single form into two steps — (1) choose
  Google / Microsoft / email, (2) choose a username with live availability
  feedback. Keep the existing error/retry affordance.
- **Dynamic type**: verify every list row, bubble and control deck at 200%
  system font size; cap scaling only where truncation would break meaning
  (`fontScaleCaps` exists for this).
- **Reduced motion**: gate the incoming-call pulse, canvas transitions, bubble
  spring and overlay fades on the existing `useReducedMotion` hook.
- **Contrast**: re-verify AA for every new semantic token pairing, including the
  audio-call ambient background.
- **Screen reader**: keep the call-state announcements; extend to message
  send/failure, reconnect start/end, and call-log filter changes.
- **Touch targets**: `touchSlop` / `minTouchTarget` discipline for the new FABs,
  chips and segmented controls.

---

## 6. Gotchas worth not rediscovering

- **`Sheet` must not call `useSafeAreaInsets()`** — it throws "No safe area value
  available" without a provider. It reads `SafeAreaInsetsContext` via
  `useContext` instead (`null` when absent). Elsewhere insets are read only at
  shell level (`AppShell`, `TabShell`) and passed down as numbers.
- **Counting rows in `react-test-renderer`**: one `ListItem` produces *three*
  fibers with the same testID (composite, `Pressable`, host `View`). Filter on
  `typeof n.type === 'string'` to count each row once; `=== 'function'`
  over-counts. `CallsScreen.test.tsx` and `PeoplePickerSheet.test.tsx` each keep
  a local `rowCount` helper.
- **A composite returning `null` still appears in `tree.root.findAll`** with its
  props — assert "renders nothing" against a *host* node, not the component's
  own testID.
- **`theme.test.ts` invariant**: `Object.keys(palettes.light).sort()` must equal
  `Object.keys(palettes.dark).sort()`. `ambient` is fixed-dark in both schemes,
  so it must **not** be added to the `SURFACES` list.
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
