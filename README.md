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

The server listens on port `4173` by default and exposes a health endpoint
plus an operational metrics endpoint:

```bash
curl http://localhost:4173/health
# => {"status":"ok","service":"studious-robot-signaling", ...}

curl http://localhost:4173/metrics
# => {"rooms":{"activeRooms":0,...},"counters":{"connectionsTotal":0,...}, ...}
```

The server reads its configuration from the environment via a single validated
config module (`server/src/config.js`):

| Variable        | Default     | Purpose                                            |
| --------------- | ----------- | -------------------------------------------------- |
| `PORT`          | `4173`      | Listen port                                        |
| `HOST`          | `0.0.0.0`   | Listen host                                        |
| `MAX_ROOM_SIZE` | `2`         | Maximum participants per room                      |
| `CORS_ORIGIN`   | `*` (dev)   | Allowed browser origin(s); empty in prod if unset  |
| `REDIS_URL`     | _(unset)_   | Enable the Socket.IO Redis adapter for horizontal scaling |
| `SENTRY_DSN`    | _(unset)_   | Enable Sentry error reporting (telemetry)          |
| `INSTANCE_ID`   | `local-<pid>` | Instance label surfaced in `/health` and `/metrics` |
| `TURN_SECRET`   | _(unset)_   | coturn shared secret for minting TURN credentials  |
| `TURN_URLS`     | _(unset)_   | Comma-separated TURN URLs handed to clients        |
| `TURN_TTL_SECONDS` | `86400`  | Lifetime of issued TURN credentials                |

The server shuts down gracefully on `SIGTERM`/`SIGINT`, draining Socket.IO
connections so platforms like Render can perform zero-downtime redeploys.

### Horizontal scaling, telemetry, and TURN provisioning

These features are **opt-in** and activate only when their environment
variables are set; with none set the server behaves exactly as before.

- **Horizontal scaling (`REDIS_URL`)** — attaches `@socket.io/redis-adapter`
  so multiple server replicas behind a load balancer share room/broadcast state
  (a prerequisite for autoscaling). The Redis packages are *optional*
  dependencies: if they are absent the server logs a warning and continues in
  single-instance mode rather than failing to boot.
- **Telemetry (`SENTRY_DSN`)** — reports captured errors (including
  `uncaughtException`/`unhandledRejection`) to Sentry via the optional
  `@sentry/node` dependency, falling back to structured console logging when the
  DSN is unset or the package is unavailable.
- **TURN provisioning (`TURN_SECRET` + `TURN_URLS`)** — exposes
  `GET /turn-credentials`, which mints short-lived, HMAC-signed credentials
  using coturn's `use-auth-secret` (TURN REST API) scheme so clients never embed
  the long-lived shared secret. When unconfigured the endpoint returns `404`.

  ```bash
  curl http://localhost:4173/turn-credentials
  # => {"username":"<expiry>","credential":"<hmac>","ttl":86400,
  #     "urls":["turn:host:3478"],"iceServers":[ ... ]}
  ```

  Configure coturn with `use-auth-secret` and a `static-auth-secret` equal to
  `TURN_SECRET`; point `TURN_URLS` at the same server.

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

### GitHub Actions — Mobile CI

[`.github/workflows/mobile-ci.yml`](./.github/workflows/mobile-ci.yml) runs on
every pull request and push to `master` that touches `mobile/`. It installs
dependencies and runs `npm run lint` and `npm test` so JavaScript regressions
are caught before the (slower) Android APK build runs.

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

---

## Mobile call-lifecycle state machine & auto-hiding controls

- **Call state machine** — `mobile/src/callStateMachine.js` is a pure, unit-tested
  finite-state machine (`idle → previewing → connecting → joined → connected`,
  plus `reconnecting`/`ended`). `useWebRTCCall` dispatches lifecycle events into
  it; `isReconnecting` is derived from the phase and the current phase is
  exposed as `callPhase`, replacing several overlapping ad-hoc booleans.
- **Auto-hiding control deck** — `mobile/src/hooks/useAutoHidingControls.js`
  fades the in-call control deck after a few seconds of inactivity and reveals
  it again on a tap (or any control interaction); it stays pinned while the
  audio-output menu is open.

## Roadmap — items requiring a native toolchain

The following backlog items need native dependencies and a device build, which
cannot be compiled or validated in the CI/Codespaces sandbox. They are tracked
here with concrete integration steps for whoever picks them up on a machine with
the Android/iOS toolchain:

- **Icon fonts** — add `react-native-vector-icons`, register the font assets in
  `android/app/build.gradle` (`fonts.gradle`) and the iOS `Info.plist`
  (`UIAppFonts`), then replace the emoji/text glyphs in the control deck.
- **Safe-area handling** — add `react-native-safe-area-context`, wrap the app in
  `SafeAreaProvider`, and swap the `react-native` `SafeAreaView` in `App.js` for
  the context-aware component (correct insets on notched devices).
- **Navigation** — adopt `@react-navigation/native` (+ a stack navigator and its
  native peers `react-native-screens`/`react-native-safe-area-context`) to
  replace the conditional Lobby/CallScreen render in `App.js` with real routes;
  `callPhase` from the state machine is a natural navigation driver.
- **TypeScript adoption** — add a `tsconfig.json`, `typescript`, and
  `@babel/preset-typescript`, enable the TS Jest transform, and migrate modules
  incrementally starting with the dependency-free units (`theme`,
  `callStateMachine`, `webrtcConfig`).

