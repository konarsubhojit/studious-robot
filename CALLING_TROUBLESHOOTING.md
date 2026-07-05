# Calling Troubleshooting Guide

This guide covers the three most common calling problems and the configuration
required on your end to resolve them:

1. [Icons not visible in the calling UI](#1-icons-not-visible-in-the-calling-ui)
2. [Picture-in-Picture (PiP) not opening when switching apps](#2-picture-in-picture-not-opening-when-switching-apps)
3. [Call not ringing on the receiver's phone](#3-call-not-ringing-on-the-receivers-phone)

---

## 1. Icons not visible in the calling UI

**Symptom:** The call controls (mute, hang-up, camera flip, speaker, etc.) show
blank boxes, "tofu" (□) glyphs, or emoji instead of crisp vector icons.

**Root cause:** The `MaterialCommunityIcons.ttf` font that
`react-native-vector-icons` renders from was not bundled into the APK. When the
font is missing, `IconButton` falls back to emoji/Unicode glyphs.

### Fix (already applied in this repo)

`mobile/android/app/build.gradle` now applies the vector-icons `fonts.gradle`
so the font is copied into the APK's `assets/fonts/` folder at build time:

```groovy
project.ext.vectoricons = [
    iconFontNames: ['MaterialCommunityIcons.ttf'],
]
apply from: file("../../node_modules/react-native-vector-icons/fonts.gradle")
```

On iOS, `ios/StudiousRobot/Info.plist` declares the font under `UIAppFonts`;
you must also add the `.ttf` file to the Xcode target (see `SETUP.md`).

### How to verify the font is actually in the bundled APK

```bash
# List the icon fonts packaged inside the APK
unzip -l app-release.apk | grep assets/fonts/

# Expect a line ending in:
#   assets/fonts/MaterialCommunityIcons.ttf
```

The **Android APK** CI workflow (`.github/workflows/android-apk.yml`) runs this
exact check on every build and fails if the font is missing, so a green build
guarantees the icons are present.

### If icons are still missing after installing a fresh build

- Do a clean rebuild so the font-copy task re-runs:
  ```bash
  cd mobile/android && ./gradlew clean assembleRelease
  ```
- Make sure `node_modules` is installed (`npm ci` in `mobile/`) before building,
  otherwise `fonts.gradle` / the `.ttf` source file will not exist.
- The set of semantic icons the app uses is defined in
  `mobile/src/vectorIcons.js` (`ICONS`). All of them belong to the
  MaterialCommunityIcons family, which is the single font we bundle.

---

## 2. Picture-in-Picture not opening when switching apps

**Symptom:** During a call, leaving the app keeps PiP working sometimes but not
others — most notably it fails when you **navigate back** (Back button/gesture)
rather than pressing **Home**.

**Root cause:** Android only calls `onUserLeaveHint()` when the user presses
**Home** or **Recents** — **not** when they press **Back**. The original code
entered PiP only from `onUserLeaveHint()`, so Back navigation would finish the
screen instead of shrinking it into a floating window.

### Fix (already applied in this repo)

`mobile/android/app/src/main/java/com/wetalk/MainActivity.kt`:

- **Android 12+ (API 31+):** enables `setAutoEnterEnabled(true)` on the PiP
  params while a call is active. The system then auto-enters PiP on *any*
  app-leave — Home **and** Back — which is the reliable, recommended approach.
- **Android 8–11 (API 26–30):** overrides `onBackPressed()` to enter PiP
  (instead of finishing) when a call is active, so Back navigation keeps the
  call floating.
- `onUserLeaveHint()` is retained and hardened with a device PiP-support check
  and try/catch so unsupported/quirky OEM devices never crash.

`CallServiceModule` refreshes the activity's PiP params whenever a call starts
or stops, so auto-enter reflects the live call state. The
`android.software.picture_in_picture` feature is declared in the manifest.

### Configuration required on your end

PiP is a per-app system permission that is **off by default on many devices**.
If PiP never appears even on Android 12+, enable it:

**Settings → Apps → WeTalk → Picture-in-picture → Allow.**

(The exact path varies by manufacturer, e.g. *Settings → Apps → Special app
access → Picture-in-picture*.)

Also note:

- PiP requires the call to be active (the foreground call service running).
- A few low-end / Go-edition devices do not support PiP at all
  (`FEATURE_PICTURE_IN_PICTURE` is absent); on those the call simply continues
  full-screen instead of floating.

---

## 3. Call not ringing on the receiver's phone

**Symptom:** You place a call, but the receiver's phone never rings —
especially when the receiver's app is in the background or has been swiped away.

There are two delivery paths, and each has its own requirements:

### A. Receiver's app is open / connected (real-time via Socket.IO)

When the receiver is online, the server emits a `call.incoming` event over the
signaling socket and the app rings immediately (CallKeep system UI, or a JS
ringtone fallback). If this path fails, check:

- The signaling server is reachable from the device (`SIGNALING_URL`).
- The receiver has completed registration/verification so the server knows which
  socket to target.

### B. Receiver's app is backgrounded or killed (push notification)

This path requires **Firebase Cloud Messaging (FCM)** to be fully configured.
This is the most common reason calls "don't ring."

**Fix already applied in this repo:** the server now sends a **data-only**
high-priority FCM message (`server/src/push.js`). A message that contains a
top-level `notification` block is delivered straight to the system tray and
**skips** the app's background handler when the app is backgrounded/killed — so
the full-screen CallKeep incoming-call UI would never appear. Data-only +
`android.priority: 'high'` wakes the background handler, which then rings the
call via CallKeep.

**Configuration required on your end:**

1. **Firebase project + `google-services.json`** — add your Android app
   (`com.wetalk`) in the Firebase console, download `google-services.json`, and
   place it at `mobile/android/app/google-services.json` (or set the
   `GOOGLE_SERVICES_JSON_B64` CI secret). See `FIREBASE_SETUP.md`.

2. **Server FCM credentials** — set `FCM_SERVICE_ACCOUNT_JSON` to your Firebase
   service-account JSON (string or file path). Without it, the server logs a
   warning and skips push delivery. See `SETUP.md` → *Push notifications*.

3. **Notification permission** — on Android 13+ the user must grant the
   `POST_NOTIFICATIONS` runtime permission, and CallKeep needs its phone-account
   permission granted the first time (the app prompts for this).

4. **Device token registered** — the receiver's app must have registered its
   push token with the server (`POST /devices/register`). This happens
   automatically once messaging + permission are set up; verify the device row
   exists server-side.

5. **APNs (iOS only)** — set `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID`, and `APNS_PRODUCTION`, and enable the VoIP/Push
   entitlements in Xcode (see `SETUP.md`).

**Battery optimization:** aggressive OEM battery managers (Xiaomi, Oppo, Vivo,
Samsung, etc.) can delay or drop high-priority FCM pushes when the app is
force-stopped. If ringing is unreliable on a specific phone, disable battery
optimization / enable "Autostart" for WeTalk in the device settings.

### How to verify push delivery end-to-end

1. Ensure `google-services.json` is present and `FCM_SERVICE_ACCOUNT_JSON` is
   set on the server.
2. Background the receiver app, then place a call.
3. Check the server logs for a line like
   `[push] Delivered call.incoming callId=… via fcm to device=…`.
   - If you see `skipping` / a warning instead, the FCM credentials are missing.
   - If delivery succeeds but the phone stays silent, check the receiver's
     notification permission, PiP/battery settings, and that CallKeep's phone
     account is enabled.
