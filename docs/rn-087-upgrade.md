# React Native 0.87 upgrade

## Why this is a separate task

React Native uses semver-minor releases as its breaking-change channel. This
upgrade must not ride in a grouped dependency PR: the toolchain and native
packages need to move as a tested set, followed by an APK/device build and
manual QA.

## Version set

Upgrade and verify these together:

- `react-native` 0.87.1
- `@react-native/babel-preset`, `@react-native/eslint-config`, and
  `@react-native/metro-config` 0.87.1
- `@react-native/jest-preset` compatible with 0.87.1; the
  `react-native/jest-preset` subpath was removed, so Jest must use the package
  form
- `react-native-reanimated` 4.6.0 with `react-native-worklets` 0.12.1.
  Reanimated 4.6 supports RN 0.83–0.87 and pairs with Worklets 0.12.x.
- `react-native-gesture-handler` 3.2.1
- `react` and `react-test-renderer` 19.2.8

## Code and configuration audit

- **`mobile/src/ThemeProvider.tsx`:** `useColorScheme()` now returns
  `ColorSchemeName | null`. Handle `null` explicitly instead of relying on the
  old non-null/`'unspecified'` behavior. Preserve System/Light/Dark overrides,
  including persistence to `wetalk-theme.json`; System mode must still follow
  live OS changes.
- **Jest:** use `preset: '@react-native/jest-preset'`, not the removed
  `react-native/jest-preset` subpath. The repository already uses the package
  form; retain and verify it.
- **Deep imports:** search for `react-native/src/private/...`. They may still
  resolve at runtime but lose TypeScript coverage; replace them with public
  APIs or explicitly document and accept each remaining import. None are
  present before this upgrade.
- **List keyboard behavior:** reject boolean `keyboardShouldPersistTaps`
  values in `ScrollView`, `FlatList`, and `SectionList`; use supported string
  values. The current call sites use `"handled"`.
- **Touchable types:** replace any `Touchable` type imports with `ViewProps`.
  None are present before this upgrade.
- **Node:** RN 0.87 requires Node >= 22.13.0. `.nvmrc` pins Node 24, so the
  development and CI runtime already satisfies the requirement. Verify that
  the `engines.node` ranges in `mobile/package.json` and `server/package.json`
  remain compatible (they are currently `>=22`) and record the versions used
  for the upgrade build.

## Gesture-handler risk

RNGH 3.2 reimplemented `Pressable` on `Touchable` and refactored `Touchable`
off `GestureDetector` on Android, iOS, and Web. The most exposed components are:

- `SwipeableRow`, used by chat-list and call-history actions, especially its
  `activeOffsetX`/`failOffsetY` arbitration
- `MediaViewer`, which composes Pinch, Pan, and Tap gestures

Specifically re-test the long-press-inside-swipe race documented in the Phase 6
notes: a message long press must remain available without blocking horizontal
swipe or normal vertical scrolling.

## `react-native-incall-manager` 4.2.2

Version 4.2.2 raises Android `minSdkVersion` from 21 to 24. The current value in
`mobile/android/build.gradle` is **24**, so no SDK bump is needed.

The release also fixes Android ringtone restoration overriding call audio. That
overlaps the audio-session work merged in #166; verify that ringtone cleanup
does not undo the intended in-call route or conflict with that work.

## Device QA checklist

Run this checklist on a physical device after unit/CI checks and an APK build:

- [ ] Switch among System, Light, and Dark; in System mode, change the OS theme
      and verify that the app follows it live.
- [ ] Use chat-list and call-history swipe actions and verify vertical-scroll
      arbitration.
- [ ] Long-press a message bubble, including from inside the swipe surface.
- [ ] In the media viewer, pinch, pan, and double-tap.
- [ ] Complete a call: connect → mute → speaker/earpiece → camera switch → end.
- [ ] Connect a Bluetooth audio device, remove it mid-call, and verify routing.
- [ ] Start and stop screen sharing.
- [ ] Enter and exit picture-in-picture.

## Sequencing

Land this task **after** the cheap Dependabot work (#184, the Actions bumps,
and Jest), and **separately** from the Gradle wrapper bump in #183. This keeps
an APK build failure attributable to one candidate cause instead of several.
