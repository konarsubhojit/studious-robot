# WeTalk — Firebase Setup Guide

Complete step-by-step instructions for wiring Firebase into the WeTalk app (Android + iOS) and the signaling server (FCM push delivery).

---

## Table of Contents

1. [Overview](#overview)
2. [Step 1 — Create a Firebase project](#step-1--create-a-firebase-project)
3. [Step 2 — Android app setup](#step-2--android-app-setup)
   - [Register the Android app](#21-register-the-android-app)
   - [Download and place google-services.json](#22-download-and-place-google-servicesjson)
   - [Verify Gradle configuration](#23-verify-gradle-configuration)
4. [Step 3 — iOS app setup](#step-3--ios-app-setup)
   - [Register the iOS app](#31-register-the-ios-app)
   - [Download and place GoogleService-Info.plist](#32-download-and-place-googleservice-infoplist)
   - [Add the file to Xcode](#33-add-the-file-to-xcode)
   - [Enable Push Notifications and Background Modes](#34-enable-push-notifications-and-background-modes)
   - [Upload the APNs key to Firebase](#35-upload-the-apns-key-to-firebase)
5. [Step 4 — Server: FCM push delivery](#step-4--server-fcm-push-delivery)
   - [Generate a service account key](#41-generate-a-service-account-key)
   - [Configure the server](#42-configure-the-server)
6. [Step 5 — Verify the integration](#step-5--verify-the-integration)
7. [Troubleshooting](#troubleshooting)

---

## Overview

WeTalk uses Firebase for one purpose: **push notifications for incoming calls**.

| Component | Firebase product | Config file |
|-----------|-----------------|-------------|
| Android app (receive pushes) | Firebase Cloud Messaging (FCM) | `google-services.json` |
| iOS app (receive pushes) | FCM via APNs | `GoogleService-Info.plist` |
| Signaling server (send pushes) | FCM HTTP v1 API | Service account JSON |

The JS packages `@react-native-firebase/app` and `@react-native-firebase/messaging` are already installed and wired up in `mobile/index.js`. You only need to supply the platform-specific config files.

---

## Step 1 — Create a Firebase project

1. Go to the [Firebase Console](https://console.firebase.google.com) and sign in with a Google account.
2. Click **Add project**.
3. Enter a project name (e.g. `wetalk-prod`). Click **Continue**.
4. Choose whether to enable Google Analytics (not required for push notifications). Click **Create project**.
5. Wait for provisioning to complete, then click **Continue**.

> **One project for both platforms.** You will register both your Android and iOS apps under this single Firebase project.

---

## Step 2 — Android app setup

### 2.1 Register the Android app

1. In the Firebase Console, open your project and click the **Android** icon (or go to **Project settings → Your apps → Add app → Android**).
2. Fill in the form:

   | Field | Value |
   |-------|-------|
   | **Android package name** | `com.wetalk` |
   | **App nickname** _(optional)_ | WeTalk Android |
   | **Debug signing certificate SHA-1** _(optional)_ | Leave blank for now; add it later for Google Sign-In if needed |

3. Click **Register app**.

### 2.2 Download and place google-services.json

1. Click **Download google-services.json**.
2. Place the file at exactly this path in the repository:

   ```
   mobile/android/app/google-services.json
   ```

   > ⚠️ **Do not commit this file to a public repository.** It contains your Firebase project ID and API keys. Add it to `.gitignore` or manage it via CI secrets (see [CI / CD](#ci--cd) in `SETUP.md`).

3. Click **Next** on the remaining wizard screens and then **Continue to console** — the SDK integration is already complete in this project.

### 2.3 Verify Gradle configuration

The Gradle files are already configured in this repository. Confirm the following two entries are present:

**`mobile/android/build.gradle`** — Google Services classpath in the `dependencies` block:

```groovy
dependencies {
    classpath("com.google.gms:google-services:4.4.2")
}
```

**`mobile/android/app/build.gradle`** — plugin applied conditionally (only when the config file is present):

```groovy
if (file("google-services.json").exists()) {
    apply plugin: "com.google.gms.google-services"
}
```

> The conditional `if` block means the Android app builds cleanly even without `google-services.json` (push notifications are silently disabled). Once you drop in the file, FCM is automatically enabled on the next build.

**Rebuild the Android app** after placing the file:

```bash
cd mobile
npx react-native run-android
# or for a release build:
cd android && ./gradlew assembleRelease
```

---

## Step 3 — iOS app setup

### 3.1 Register the iOS app

1. In the Firebase Console, open your project and click the **iOS+** icon (or go to **Project settings → Your apps → Add app → Apple**).
2. Fill in the form:

   | Field | Value |
   |-------|-------|
   | **Apple bundle ID** | `com.wetalk` |
   | **App nickname** _(optional)_ | WeTalk iOS |
   | **App Store ID** _(optional)_ | Leave blank until you have one |

3. Click **Register app**.

### 3.2 Download and place GoogleService-Info.plist

1. Click **Download GoogleService-Info.plist**.
2. Place the file at:

   ```
   mobile/ios/StudiousRobot/GoogleService-Info.plist
   ```

   > ⚠️ Like `google-services.json`, do not commit this to a public repository.

3. Click through the remaining wizard screens — the SDK integration is already present.

### 3.3 Add the file to Xcode

The plist must be **added to the Xcode project** (not just placed on disk) so it is bundled into the app:

1. Open `mobile/ios/StudiousRobot.xcworkspace` in Xcode (use the `.xcworkspace`, not `.xcodeproj`).
2. In the **Project navigator** (left panel), right-click the `StudiousRobot` **group** (the folder with the app name) and choose **Add Files to "StudiousRobot"…**
3. Navigate to and select `GoogleService-Info.plist`.
4. In the sheet that appears:
   - ✅ Check **Copy items if needed**
   - Set **Added to targets** to **StudiousRobot** (ensure the checkbox is ticked)
5. Click **Add**.

The file should now appear inside the `StudiousRobot` group in the Project navigator.

### 3.4 Enable Push Notifications and Background Modes

1. In Xcode, click the **StudiousRobot** project in the navigator, then select the **StudiousRobot target**.
2. Go to the **Signing & Capabilities** tab.
3. Click **+ Capability** and add:
   - **Push Notifications**
   - **Background Modes** → tick **Remote notifications**

These capabilities write the required entitlements into `StudiousRobot.entitlements` automatically.

4. Ensure **Automatically manage signing** is on and your Apple Developer account is selected in **Team**.

### 3.5 Upload the APNs key to Firebase

Firebase needs an APNs authentication key to deliver pushes on your behalf:

1. In the [Apple Developer portal](https://developer.apple.com) → **Certificates, Identifiers & Profiles** → **Keys**, click **+** to create a new key.
2. Give it a name (e.g. `WeTalk APNs`), tick **Apple Push Notifications service (APNs)**, and click **Continue → Register**.
3. Click **Download** — save the `.p8` file somewhere safe. **You can only download it once.**
4. Note the **Key ID** shown on screen and your **Team ID** (visible top-right in the Developer portal, or under **Membership**).
5. Back in the Firebase Console → **Project settings → Cloud Messaging → Apple app configuration**:
   - Under **APNs Authentication Key**, click **Upload**.
   - Select the `.p8` file.
   - Enter the **Key ID** and **Team ID**.
   - Click **Upload**.

6. Set the same APNs credentials as environment variables for the signaling server (see [Step 4](#step-4--server-fcm-push-delivery)):

   ```bash
   APNS_KEY=$(cat AuthKey_XXXXXXXXXX.p8)
   APNS_KEY_ID=XXXXXXXXXX          # 10-char key ID
   APNS_TEAM_ID=XXXXXXXXXX         # 10-char Team ID
   APNS_BUNDLE_ID=com.wetalk
   APNS_PRODUCTION=false           # set to true for App Store / TestFlight
   ```

**Rebuild the iOS app** after the Xcode changes:

```bash
cd mobile/ios && pod install && cd ..
npx react-native run-ios
# or for a specific device:
npx react-native run-ios --device "Your iPhone Name"
```

---

## Step 4 — Server: FCM push delivery

The signaling server sends push notifications directly to FCM using the HTTP v1 API. It authenticates with a **service account** JSON key — not with the `google-services.json` client-side file.

### 4.1 Generate a service account key

1. In the Firebase Console → **Project settings → Service accounts**.
2. Ensure **Firebase Admin SDK** is selected (it is by default).
3. Click **Generate new private key** → **Generate key**.
4. A JSON file is downloaded (e.g. `wetalk-prod-firebase-adminsdk-xxxxx.json`). Store it securely — treat it like a password.

### 4.2 Configure the server

The server reads the service account from the `FCM_SERVICE_ACCOUNT_JSON` environment variable. Set it to the **minified** (single-line) JSON:

```bash
# Minify with jq (recommended)
FCM_SERVICE_ACCOUNT_JSON=$(jq -c . < wetalk-prod-firebase-adminsdk-xxxxx.json)
export FCM_SERVICE_ACCOUNT_JSON
```

Or, if you don't have `jq`, use Python:

```bash
FCM_SERVICE_ACCOUNT_JSON=$(python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))" wetalk-prod-firebase-adminsdk-xxxxx.json)
export FCM_SERVICE_ACCOUNT_JSON
```

Add this variable to your server's environment:

- **Local development:** add to `server/.env`
- **Oracle VM:** add `Environment=FCM_SERVICE_ACCOUNT_JSON=<minified-json>` to the `[Service]` block in `/etc/systemd/system/robot-signal.service`, then run `sudo systemctl daemon-reload && sudo systemctl restart robot-signal`
- **Linux VM (systemd):** add to `/etc/robot-signal.env`

Restart the server after setting the variable. You should see this log line at startup:

```
[Push] FCM configured (project: wetalk-prod)
```

If `FCM_SERVICE_ACCOUNT_JSON` is absent or malformed, the server starts normally and logs:

```
[Push] FCM not configured – skipping FCM push delivery
```

---

## Step 5 — Verify the integration

### Android verification

1. Install a **debug build** on a physical Android device (FCM does not work on emulators without Play Services).
2. Put the app in the background or force-stop it.
3. From the Firebase Console → **Cloud Messaging → Send your first message**:
   - **Notification title:** Test call
   - **Target:** your app package `com.wetalk`
   - Click **Send test message**, enter the FCM registration token from the device logs, and send.
4. The device should display a notification. Check Metro / `adb logcat` for `[Push]` log lines from `pushNotifications.js`.

### iOS verification

1. Install on a **physical device** (APNs does not work on the simulator).
2. Background the app.
3. Trigger a test push from Firebase Console (same as above, targeting your iOS app) or use the server's `/session` endpoint to initiate a call from a second device.
4. The device should ring via CallKit.

### End-to-end call push test

With both the server and app running:

1. Open the app on device A and device B.
2. On device A, background the app (or force-stop it).
3. On device B, initiate a call to device A.
4. The server sends an FCM/APNs push to device A.
5. Device A should show a full-screen incoming-call UI (CallKit on iOS, heads-up notification on Android) even from a killed state.

---

## Troubleshooting

### `No Firebase App '[DEFAULT]' has been created`

`@react-native-firebase/app` was not imported before `@react-native-firebase/messaging`. Confirm the first two imports in `mobile/index.js` are:

```js
import 'react-native-gesture-handler';
import '@react-native-firebase/app';
```

This is already fixed in the current codebase.

### `google-services.json` / `GoogleService-Info.plist` not found

The build will succeed without these files (the Gradle plugin is applied conditionally), but push notifications will not work. Ensure the files are at the exact paths:

```
mobile/android/app/google-services.json
mobile/ios/StudiousRobot/GoogleService-Info.plist
```

### FCM token not returned / push not delivered

- Confirm `google-services.json` matches the **exact** package name `com.wetalk`.
- Confirm the device has Google Play Services installed and updated.
- Check `adb logcat` for `FirebaseMessaging` tags.

### iOS push not received in background

- Confirm **Push Notifications** capability is enabled in Xcode.
- Confirm **Background Modes → Remote notifications** is ticked.
- Confirm the APNs key uploaded to Firebase is for the correct **Team ID** and **bundle ID** (`com.wetalk`).
- Use a real device — APNs is not supported on the iOS Simulator.

### Server logs `FCM_SERVICE_ACCOUNT_JSON is malformed`

The JSON must be a single line with no wrapping quotes. Re-run the `jq -c` minification step and make sure the variable value starts with `{` and ends with `}`.

### Deprecation warning: `This method is deprecated … Please use getApp() instead`

This was caused by calling `messaging()` as a factory. It is fixed in the current codebase — `pushNotifications.js` uses `messaging.method()` directly (modular API).
