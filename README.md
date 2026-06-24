# studious-robot

Cloud-first project with two folders:

| Path       | Purpose                                                  |
| ---------- | -------------------------------------------------------- |
| `mobile/`  | React Native app (React Native CLI)                      |
| `server/`  | Node.js signaling server (Express + Socket.IO + `/health`) |

This project is split into a signaling backend and a React Native mobile client.
The backend is developed entirely in GitHub Codespaces; the mobile app uses the
React Native CLI and is built with the Android/iOS native toolchains (or via the
CI workflow that produces a debug APK).

---

## Prerequisites

- A GitHub Codespace for this repository (recommended for the server). Locally,
  you need Node.js matching [`.nvmrc`](./.nvmrc) (run `nvm use`).
- For Android builds: JDK 17+ and the Android SDK (Android Studio recommended).
- For iOS builds: Xcode and CocoaPods (macOS only).

## First-time setup (in a Codespace)

```bash
# 1. Use the pinned Node version
nvm use

# 2. Install dependencies for each folder
cd server && npm install && cd ..
cd mobile && npm install && cd ..
```

## Run the signaling server

```bash
cd server
npm run dev        # auto-restart on changes (or: npm start)
```

The server listens on port `4173` by default and exposes a health endpoint:

```bash
curl http://localhost:4173/health
# => {"status":"ok","service":"studious-robot-signaling", ...}
```

In Codespaces, forward port `4173` (the Ports panel handles this automatically
the first time the port is bound) and use the generated public URL to reach
`/health` from a browser.

## Run the mobile app

```bash
cd mobile
npm start            # start the Metro bundler
npm run android      # build & launch on a connected Android device/emulator
```

See [`mobile/README.md`](./mobile/README.md) for the full toolchain setup and
environment variables (`SIGNALING_URL`, `ROOM_ID`, `TURN_USERNAME`,
`TURN_CREDENTIAL`).

## Common npm scripts

Both folders expose a consistent script surface:

| Script         | `server/`                        | `mobile/`                        |
| -------------- | -------------------------------- | -------------------------------- |
| `npm start`    | Run the signaling server         | `react-native start`             |
| `npm run dev`  | Run with `node --watch`          | —                                |
| `npm test`     | `node --test`                    | `jest`                           |

## Verifying a fresh setup

A new contributor should be able to:

1. Open the repository in a Codespace.
2. Run `npm install` inside `server/` and `mobile/`.
3. `cd server && npm start` and see `[signaling] listening on http://0.0.0.0:4173`.
4. `curl http://localhost:4173/health` and receive `{"status":"ok", ...}`.
5. In another terminal, `cd mobile && npm start` to launch the Metro bundler, then
   `npm run android` to build and run the app.

---

## Automated tests

### Running tests locally

```bash
# Server – Node.js built-in test runner
cd server && npm test

# Mobile – Jest
cd mobile && npm test
```

Both commands run the full test suite for their package and exit non-zero on
any failure.  Run them before opening a pull request.

### Test inventory

| Package  | File                                  | What it covers                                               |
| -------- | ------------------------------------- | ------------------------------------------------------------ |
| `server` | `test/calls.test.js`                  | Call lifecycle HTTP endpoints (create, accept, decline, cancel, end, history, timeouts) |
| `server` | `test/signaling-contract.test.js`     | Versioned WebSocket call/RTC signaling contract              |
| `server` | `test/reconnect.test.js`              | Socket reconnect, network handoff, offline callee, ICE restart |
| `server` | `test/push-fallback.test.js`          | Push-notification fallback for offline callees               |
| `server` | `test/identity.test.js`               | Session, device registration, and presence APIs              |
| `server` | `test/telemetry.test.js`              | Metrics counters and derived rates                           |
| `server` | `test/security.test.js`               | Rate limiting and blocklist                                  |
| `server` | `test/signaling.test.js`              | Legacy join-room signaling                                   |
| `server` | `test/health.test.js`                 | Health endpoint                                              |
| `mobile` | `__tests__/hooks/useCallFlow.test.js` | Call phases, push rehydration (all terminal + ringing states), camera switch |
| `mobile` | `__tests__/hooks/useWebRTCCall.test.js` | WebRTC camera switch hardening                             |
| `mobile` | `__tests__/hooks/useCompactCallView.test.js` | PiP compact-view logic                               |
| `mobile` | `__tests__/components/`               | Incoming/outgoing/in-call UI components                      |

### CI workflows and merge gates

| Workflow                                    | Trigger                        | Gate            |
| ------------------------------------------- | ------------------------------ | --------------- |
| `backend-ci.yml` — *Lint, build & test*     | PR / push to `master` (server) | Blocks merge    |
| `mobile-ci.yml` — *Unit tests*              | PR / push to `master` (mobile) | Blocks merge    |
| `android-apk.yml` — *Build APK(s)*          | PR / push to `master` (mobile) | —               |

All three workflows run automatically.  A pull request that touches `server/`
must pass `backend-ci.yml`; a PR touching `mobile/` must pass `mobile-ci.yml`.
The APK build is informational (the artifact is uploaded but the check does not
gate the merge on its own).

### Scenario coverage

The following critical call paths have repeatable automated test coverage:

| Scenario                              | Test file(s)                                          |
| ------------------------------------- | ----------------------------------------------------- |
| Ringing → accepted → in-call → ended  | `calls.test.js`, `signaling-contract.test.js`         |
| Caller cancels before acceptance      | `calls.test.js`                                       |
| Callee declines                       | `calls.test.js`                                       |
| Ringing timeout (missed)              | `calls.test.js`, `telemetry.test.js`                  |
| Callee busy (second incoming call)    | `calls.test.js`, `telemetry.test.js`                  |
| Callee unreachable (unknown user)     | `calls.test.js`                                       |
| Offline callee → push notification    | `push-fallback.test.js`                               |
| Socket disconnect preserves call      | `reconnect.test.js`                                   |
| Network handoff (ICE restart)         | `reconnect.test.js`                                   |
| Reconnected participant receives events | `reconnect.test.js`                                 |
| Multiple sockets per user             | `reconnect.test.js`                                   |
| Push rehydration (ringing/missed/ended) | `useCallFlow.test.js`                               |
| Push rehydration (active/terminal states) | `useCallFlow.test.js`                             |
| Incoming/outgoing call UI             | `IncomingCallScreen.test.js`, `OutgoingCallScreen.test.js` |
| PiP / compact in-call view            | `CallScreen.test.js`, `useCompactCallView.test.js`    |

---

## Cloud delivery (Phase 5)

### Android APKs

[`.github/workflows/android-apk.yml`](./.github/workflows/android-apk.yml)
is a single combined workflow that builds both the debug and release APKs.

- **Pull requests** to `master`: builds and uploads the **debug APK** only
  (`app-debug-apk` artifact, kept for 3 days).
- **Push to `master`** or **manual `workflow_dispatch`**: builds and uploads
  both APKs in a single Gradle invocation (`app-debug-apk` and
  `app-release-apk` artifacts, each kept for 3 days).

The workflow limits the Android ABI to `arm64-v8a` in CI
(`-PreactNativeArchitectures=arm64-v8a`) so the Gradle build is 2–4× faster
than building all four ABIs. Local builds still use all four ABIs as configured
in `mobile/android/gradle.properties`.

A `concurrency` group cancels any in-progress run for the same branch when a
newer commit is pushed, avoiding wasted runner time.

> **Note:** The debug APK loads its JavaScript from the Metro bundler at runtime.
> Installing it on a device without a running Metro server will show the
> *"Unable to load script"* error. Use the **release APK** for standalone
> installation.

To build a debug APK locally:

```bash
cd mobile/android
./gradlew assembleDebug
# => app/build/outputs/apk/debug/app-debug.apk
```

The Android application id is `com.konarsubhojit.studiousrobot`. If you fork this
repository, update the `applicationId`/`namespace` in
[`mobile/android/app/build.gradle`](./mobile/android/app/build.gradle) (and the
matching Kotlin package directory) to your own identifier.

### Android release APK

The release workflow builds a **self-contained** APK that bundles the JavaScript
at build time — no Metro server required. Environment variables are inlined into
the JS bundle from GitHub repository secrets. Set these secrets before running
the workflow:

| Secret             | Description                                 |
| ------------------ | ------------------------------------------- |
| `SIGNALING_URL`    | WebSocket URL of the signaling server       |
| `ROOM_ID`          | Default room identifier                     |
| `TURN_USERNAME`    | TURN server username (optional)             |
| `TURN_CREDENTIAL`  | TURN server credential (optional)           |

To build a release APK locally:

```bash
cd mobile/android
SIGNALING_URL=https://<your-signaling-host> ./gradlew assembleRelease
# => app/build/outputs/apk/release/app-release.apk
```

### Render signaling backend

[`render.yaml`](./render.yaml) configures a Render Web Service that:

- Uses the `server/` sub-directory as the root.
- Runs `npm install --omit=dev` on build and `npm start` to serve.
- Exposes `/health` as the health-check path.

**One-time Render setup:**

1. Connect the repository to [Render](https://render.com) and choose
   *"Use render.yaml"* when creating the service.
2. In the Render dashboard → Environment, set `CORS_ORIGIN` to your mobile app's
   origin (or your custom domain).
3. Copy the **Deploy Hook URL** from the Render service settings and save it as a
   repository secret named `RENDER_DEPLOY_HOOK_URL` in GitHub.

Once deployed, verify with:

```bash
curl https://<your-render-service>.onrender.com/health
# => {"status":"ok","service":"studious-robot-signaling", ...}
```

### GitHub Actions — Backend CI & Deploy

[`.github/workflows/backend-ci.yml`](./.github/workflows/backend-ci.yml) runs
automatically on every pull request and push to `master` that touches `server/`:

1. **test** job — installs deps, runs `npm test` (Node built-in test runner).
2. **deploy** job — on `master` push only, calls the Render deploy hook
   (`RENDER_DEPLOY_HOOK_URL` secret) so the live service is always up to date.

### GitHub Actions — Android APKs

[`.github/workflows/android-apk.yml`](./.github/workflows/android-apk.yml)
builds both APKs in a single job, eliminating duplicated checkout, Node/Java
setup, and `npm ci` steps.

- On pull requests: builds the debug APK and uploads it as `app-debug-apk`.
- On push to `master` / `workflow_dispatch`: builds both APKs in one Gradle
  invocation and uploads `app-debug-apk` and `app-release-apk`.

Optimizations applied vs the previous two-workflow setup:

- npm and Gradle dependency caches (`actions/setup-node` + `actions/setup-java`)
- `org.gradle.parallel=true` and `org.gradle.caching=true` in `gradle.properties`
- Single-ABI CI build (`-PreactNativeArchitectures=arm64-v8a`), 2–4× faster
- Concurrency group cancels stale in-progress runs on the same branch
- Artifact retention capped at 3 days

### Release flow (PR merge → APK + live backend)

```
feature branch
    │
    ▼
Pull Request opened
    │  ├─ GitHub Actions: backend-ci.yml runs "test" job
    │  └─ GitHub Actions: android-apk.yml builds the debug APK
    │
    ▼
Merge to master
    │  ├─ GitHub Actions: "deploy" job triggers Render redeploy
    │  │      └─ Render builds from master → /health is live within ~2 min
    │  │
    │  └─ GitHub Actions: android-apk.yml builds debug + release APKs
    │         └─ Download app-release-apk from the Actions artifact, install on device
    ▼
QA installs release APK (no Metro needed), points app to Render URL, tests end-to-end
```
