# React Native 0.87 — upgrade decision record

Audited against `ab7591677e979d0a86b1137e99743fc5f3bdc5fd` on 2026-10-02.

## Implemented configuration

`mobile/package.json` already pins React Native **0.87.1** and the matching
Babel, ESLint, Metro, codegen and Jest preset packages. `mobile/jest.config.js`
uses `@react-native/jest-preset`. The old dependency-upgrade sequence and
candidate version list are no longer pending work; use the manifest and lockfile
for the current dependency set.

`ThemeProvider.tsx` passes the OS colour scheme through `resolveScheme` in
`theme.ts`, while preserving the saved System/Light/Dark preference.
Android `minSdkVersion` is **24** in `mobile/android/build.gradle`.

## Rationale to retain

React Native toolchain/native-package upgrades should be validated together
and separately from unrelated build changes. A native build failure is easier
to attribute when a Gradle wrapper change is not bundled with the framework
upgrade. Passing Jest/typecheck/lint does not establish native build or device
compatibility.

## Device checks

No completed physical-device results are asserted by this record. For native
dependency changes, verify:

- System/Light/Dark preferences, including live OS theme changes.
- Chat-list and call-history swipe actions without breaking vertical scroll.
- Message long press within swipe surfaces.
- Media-viewer pinch, pan and double tap.
- Call connect, mute, speaker/earpiece, camera switch and end.
- Bluetooth routing, including device removal mid-call.
- Screen-share start/stop and PiP enter/exit.
