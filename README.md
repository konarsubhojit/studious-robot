# studious-robot

Cloud-first project with two folders:

| Path       | Purpose                                                  |
| ---------- | -------------------------------------------------------- |
| `mobile/`  | React Native app (React Native CLI)                      |
| `server/`  | Node.js signaling server (Express + Socket.IO + `/health`) |
| `shared/`  | Signaling/REST contracts (event names, payload schemas, routes) shared by both |
| [`docs/`](./docs/README.md) | Setup guides, planning records, and historical reports |

This project is split into a signaling backend and a React Native mobile client.
The backend is developed entirely in GitHub Codespaces; the mobile app uses the
React Native CLI and is built with the Android/iOS native toolchains (or via the
CI workflow that produces a release APK).

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

### Deployment topology: two signaling VMs behind a load balancer

The signaling server runs as a single systemd unit **on each of two small VMs**,
with Postgres and Redis on a separate host. That is a multi-instance
deployment, so **`REDIS_URL` is mandatory on both VMs**: it is what makes the
call registry, sessions, presence, the read cache and Socket.IO fan-out shared
rather than private to each VM.

With `REDIS_URL` configured, `/health` reports `stateAffinity: "shared"` and
**round-robin (non-sticky)** load balancing is correct. Without it each VM
keeps its own copy of everything: a cache invalidation published by one never
reaches the other, a call created on VM A is invisible to VM B, and a client
that reconnects to the other VM silently loses its session. The failure is
silent, so the server refuses to start without `REDIS_URL` when it is told it
is one of several (`INSTANCE_ID` > 0, see `server/src/lib/instances.ts`) and
`NODE_ENV=production`.

**Give each VM a distinct `INSTANCE_ID`** in `/etc/robot-signal/env`
(`INSTANCE_ID=0` on the first, `1` on the second, …). Nothing sets it
automatically for separate hosts, and without it the guard above cannot tell a
two-VM fleet from a single machine.

Only a genuinely single-instance deployment — local development, the test
suite — may leave `REDIS_URL` unset, where `/health` reports
`stateAffinity: "sticky"` and the in-memory bus and cache are equivalent.

See [`deploy/README.md`](./deploy/README.md) for the full setup.

## Run the mobile app

```bash
cd mobile
npm start            # start the Metro bundler
npm run android      # build & launch on a connected Android device/emulator
```

See [`mobile/README.md`](./mobile/README.md) for the full toolchain setup and
environment variables. Configure Cloudflare TURN on the server with
`CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`; the mobile client
then receives short-lived credentials at call time.

## Common npm scripts

Both folders expose a consistent script surface:

| Script         | `server/`                        | `mobile/`                        |
| -------------- | -------------------------------- | -------------------------------- |
| `npm start`    | Run the signaling server         | `react-native start`             |
| `npm run dev`  | Run with `node --watch`          | —                                |
| `npm test`     | `node --test`                    | `jest`                           |
| `npm run typecheck` | `tsc --noEmit`              | `tsc --noEmit`                   |
| `npm run lint` | `eslint` (server + `shared/`)    | `eslint`                         |

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
| `server` | `test/calls.test.ts`                  | Call lifecycle HTTP endpoints (create, accept, decline, cancel, end, history, timeouts) |
| `server` | `test/call-history.test.ts`           | Durable `GET /calls` history: restart survival, retention independence, paging |
| `server` | `test/signaling-contract.test.ts`     | Versioned WebSocket call/RTC signaling contract              |
| `server` | `test/reconnect.test.ts`              | Socket reconnect, network handoff, offline callee, ICE restart |
| `server` | `test/push-fallback.test.ts`          | Push-notification fallback for offline callees               |
| `server` | `test/identity.test.ts`               | Session, device registration, and presence APIs              |
| `server` | `test/directory.test.ts`              | Contact directory (`GET /users`) search, paging, block filtering |
| `server` | `test/telemetry.test.ts`              | Metrics counters and derived rates                           |
| `server` | `test/query-timing.test.ts`           | SQL/Mongo/Redis query timing, slow-query threshold, per-operation breakdown |
| `server` | `test/security.test.ts`               | Rate limiting and blocklist                                  |
| `server` | `test/signaling.test.ts`              | Legacy join-room signaling                                   |
| `server` | `test/health.test.ts`                 | Health endpoint                                              |
| `mobile` | `__tests__/hooks/useCallFlow.test.tsx` | Call phases, push rehydration (all terminal + ringing states), camera switch |
| `mobile` | `__tests__/call/callStateMachine.test.ts` | Call state machine transitions (idle → ringing → connected → ended) |
| `mobile` | `__tests__/AppShell.test.tsx`          | Screen routing for each call state, minimize/restore          |
| `mobile` | `__tests__/hooks/useCompactCallView.test.tsx` | PiP compact-view logic                               |
| `mobile` | `__tests__/hooks/useScreenShare.test.tsx` | Screen sharing start/stop, optional screen audio + renegotiation |
| `mobile` | `__tests__/screenShare.test.ts`       | `getDisplayMedia` capture, audio fallback, cancellation      |
| `mobile` | `__tests__/components/SettingsScreen.test.tsx` | Settings screen (username/server edit, sign out) |
| `mobile` | `__tests__/pushNotifications.test.ts`  | Deep links + push-token acquisition/registration            |
| `mobile` | `__tests__/components/`               | Incoming/outgoing/in-call UI components                      |

### CI workflows and merge gates

| Workflow                                    | Trigger                        | Gate            |
| ------------------------------------------- | ------------------------------ | --------------- |
| `backend-ci.yml` — *Lint, build & test*     | PR / push to `master` (server) | Blocks merge    |
| `mobile-ci.yml` — *Unit tests*              | PR / push to `master` (mobile) | Blocks merge    |
| `android-apk.yml` — *Build APK(s)*          | PR / push to `master` (mobile) | —               |

All three workflows run automatically.  A pull request that touches `server/`
or `shared/` must pass `backend-ci.yml`; a PR touching `mobile/` or `shared/`
must pass `mobile-ci.yml`.  Both gates run `npm run typecheck` (see the
[documentation index](./docs/README.md)) before the tests.
The APK build is informational (the artifact is uploaded but the check does not
gate the merge on its own).

### Scenario coverage

The following critical call paths have repeatable automated test coverage:

| Scenario                              | Test file(s)                                          |
| ------------------------------------- | ----------------------------------------------------- |
| Ringing → accepted → in-call → ended  | `calls.test.ts`, `signaling-contract.test.ts`         |
| Caller cancels before acceptance      | `calls.test.ts`                                       |
| Callee declines                       | `calls.test.ts`                                       |
| Ringing timeout (missed)              | `calls.test.ts`, `telemetry.test.ts`                  |
| Callee busy (second incoming call)    | `calls.test.ts`, `telemetry.test.ts`                  |
| Callee unreachable (unknown user)     | `calls.test.ts`                                       |
| Offline callee → push notification    | `push-fallback.test.ts`                               |
| Socket disconnect preserves call      | `reconnect.test.ts`                                   |
| Network handoff (ICE restart)         | `reconnect.test.ts`                                   |
| Reconnected participant receives events | `reconnect.test.ts`                                 |
| Multiple sockets per user             | `reconnect.test.ts`                                   |
| Push rehydration (ringing/missed/ended) | `useCallFlow.test.tsx`                               |
| Push rehydration (active/terminal states) | `useCallFlow.test.tsx`                             |
| Incoming/outgoing call UI             | `IncomingCallScreen.test.tsx`, `OutgoingCallScreen.test.tsx` |
| PiP / compact in-call view            | `CallScreen.test.tsx`, `useCompactCallView.test.tsx`    |

---

## Cloud delivery (Phase 5)

### Android APKs

[`.github/workflows/android-apk.yml`](./.github/workflows/android-apk.yml)
builds the release APK only. A debug APK is deliberately not produced: React
Native's `assembleDebug` does not embed the JS bundle, so it cannot run without
a Metro dev server.

- **Pull requests** to `master`: builds and verifies the **release APK**
  (no artifact is uploaded).
- **Push to `master`** or **manual `workflow_dispatch`**: builds, verifies and
  uploads the release APK (`app-release-apk` artifact, kept for 3 days).

The workflow limits the Android ABI to `arm64-v8a` in CI
(`-PreactNativeArchitectures=arm64-v8a`) so the Gradle build is 2–4× faster
than building all four ABIs. Local builds still use all four ABIs as configured
in `mobile/android/gradle.properties`.

A `concurrency` group cancels any in-progress run for the same branch when a
newer commit is pushed, avoiding wasted runner time.

> **Note:** A debug APK loads its JavaScript from the Metro bundler at runtime.
> Installing it on a device without a running Metro server will show the
> *"Unable to load script"* error. Use the **release APK** for standalone
> installation — that is the only APK CI builds.

To build a debug APK locally (requires Metro):

```bash
cd mobile/android
./gradlew assembleDebug
# => app/build/outputs/apk/debug/app-debug.apk
```

The Android application id is `com.wetalk` (see
[`mobile/android/app/build.gradle`](./mobile/android/app/build.gradle)), and the
iOS bundle identifier matches it. If you fork this repository and want your own
identifier, update the `applicationId`/`namespace` in the Gradle build, the
matching Kotlin package directory, the `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode
project, and the package name checked by the APK workflow
([`.github/workflows/android-apk.yml`](./.github/workflows/android-apk.yml)),
which verifies that `google-services.json` contains a client for the expected
package.

### Android release APK

The release workflow builds a **self-contained** APK that bundles the JavaScript
at build time — no Metro server required. Environment variables are inlined into
the JS bundle from GitHub repository secrets. Set these secrets before running
the workflow:

| Secret             | Description                                 |
| ------------------ | ------------------------------------------- |
| `SIGNALING_URL`    | WebSocket URL of the signaling server       |
| `ROOM_ID`          | Default room identifier                     |
| `TURN_USERNAME`    | Deprecated static TURN fallback (optional)  |
| `TURN_CREDENTIAL`  | Deprecated static TURN fallback (optional)  |

To build a release APK locally:

```bash
cd mobile/android
SIGNALING_URL=https://<your-signaling-host> ./gradlew assembleRelease
# => app/build/outputs/apk/release/app-release.apk
```

### Oracle Ampere A1 signaling backend

The signaling server runs as a systemd service on an **Oracle Cloud Ampere A1 (arm64) VM**. The `backend-ci.yml` workflow SSHes into the VM on every push to `master` and performs a git-pull → npm-ci → graceful service restart automatically.

**One-time VM setup:** see [`deploy/README.md`](./deploy/README.md) for the full walkthrough (Node.js install, systemd unit, OCI firewall rules, TLS reverse proxy with Caddy/nginx, sudoers config, and Redis).

Required GitHub secrets for automated deploys:

| Secret | Description |
|--------|-------------|
| `DEPLOY_SSH_KEY` | Private key for the deploy SSH key pair |
| `DEPLOY_SSH_HOST` | VM public IP or hostname |
| `DEPLOY_SSH_USER` | VM user (`opc` on Oracle Linux) |
| `DEPLOY_SSH_PORT` | SSH port (optional, defaults to `22`) |
| `DATABASE_URL_DIRECT` | Neon direct Postgres URL for CI migrations |
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON for FCM push |

Once deployed, verify with:

```bash
curl https://signal.yourdomain.com/health
# => {"status":"ok","service":"studious-robot-signaling", ...}
```

### GitHub Actions — Backend CI & Deploy

[`.github/workflows/backend-ci.yml`](./.github/workflows/backend-ci.yml) runs
automatically on every pull request and push to `master` that touches `server/`:

1. **test** job — installs deps, runs schema drift check, applies DB migrations, runs `npm test`.
2. **deploy** job — on `master` push only, SSHes into the Oracle Ampere A1 VM and runs:
   `git fetch/reset → npm ci --omit=dev → systemctl reload-or-restart robot-signal`.

### GitHub Actions — Android APKs

[`.github/workflows/android-apk.yml`](./.github/workflows/android-apk.yml)
builds the release APK in a single job, eliminating duplicated checkout,
Node/Java setup, and `npm ci` steps.

- On pull requests: builds and verifies the release APK (no artifact upload).
- On push to `master` / `workflow_dispatch`: builds the release APK and uploads
  it as `app-release-apk`.

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
    │  └─ GitHub Actions: android-apk.yml builds the release APK
    │
    ▼
Merge to master
    │  ├─ GitHub Actions: backend-ci.yml "deploy" job SSHes into Oracle VM
    │  │      └─ git pull → npm ci → systemctl reload-or-restart → /health ✓
    │  │
    │  └─ GitHub Actions: android-apk.yml builds the release APK
    │         └─ Download app-release-apk from the Actions artifact, install on device
    ▼
QA installs release APK (no Metro needed), points app to Oracle VM URL, tests end-to-end
```
