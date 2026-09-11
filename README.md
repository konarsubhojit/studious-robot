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

`stateAffinity` is not the whole story: it says state is Redis-backed, not that
a socket broadcast crosses instances. Each instance therefore probes the
Socket.IO adapter periodically and reports what answered under `fanout` on
`/health` (`peersSeen`, `healthy`, `mixedTransport`) — see
[`deploy/README.md`](./deploy/README.md) §5a.

**Give each VM a distinct `INSTANCE_ID`** in `/etc/robot-signal/env`
(`INSTANCE_ID=0` on the first, `1` on the second, …). Nothing sets it
automatically for separate hosts, and without it the guard above cannot tell a
two-VM fleet from a single machine.

Only a genuinely single-instance deployment — local development, the test
suite — may leave `REDIS_URL` unset, where `/health` reports
`stateAffinity: "sticky"` and the in-memory bus and cache are equivalent.

See [`deploy/README.md`](./deploy/README.md) for the full setup. For the
self-hosted three-host fleet, follow the
[`VM redeploy and recovery` runbook](./docs/VM_REDEPLOY.md).

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
| `server` | `test/query-timing.test.ts`           | SQL/Redis query timing, slow-query threshold, per-operation breakdown |
| `server` | `test/security.test.ts`               | Rate limiting and blocklist                                  |
| `server` | `test/signaling.test.ts`              | Legacy join-room signaling                                   |
| `server` | `test/health.test.ts`                 | Health endpoint                                              |
| `server` | `test/fanout-probe.test.ts`           | Cross-instance fan-out probe: peer discovery, staleness, mixed transports |
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

### Self-hosted CI: opt-in copies, not a cutover

The original hosted workflows and merge gates remain unchanged. Separate
`backend-ci-self-hosted.yml`, `mobile-ci-self-hosted.yml` and
`android-apk-self-hosted.yml` workflows are available for evaluation:

- **Manual:** use **Run workflow** in Actions; registration on the default branch
  is needed before GitHub displays the dispatch control.
- **Automatic shadow checks:** set the repository Actions variable
  `SELF_HOSTED_CI_ENABLED` to `true` only after the security prerequisites below.
  Unset/false skips self-hosted jobs on push/PR without affecting hosted jobs.
  The copies include shared-code, `.nvmrc`, and shared CI-action path filters.
- **Deployment:** the backend copy does not deploy on push. Its manual `deploy`
  checkbox defaults to false, requires `master`, successful tests and the
  protected `production` environment. Hosted and self-hosted deployment jobs
  share the same non-cancelling concurrency group, preventing overlapping
  migration/SSH cycles. Do not dispatch a production deployment just to benchmark.

#### Runner inventory and role assignment

The reported inventory is `ianao`, `ianao2`, `ovh`, `ovh2`, `ovh3`, `ovh4`, all
with `self-hosted`, `Linux`, `X64` labels. These are **runner names**, not role
labels; online status, hardware capacity and isolation have not been verified.
Assign the following additional labels only after provisioning the corresponding
role. This is a proposed allocation, not a change already made in GitHub:

| Runner(s) | Additional label | Work |
| --------- | ---------------- | ---- |
| `ianao`, `ianao2` | `studious-robot-ci` | Backend and mobile typecheck/lint/tests |
| `ovh`, `ovh2` | `studious-robot-android` | PR/non-master Android builds, no release credentials |
| `ovh3` | `studious-robot-release` | Android master push/manual builds |
| `ovh4` | `studious-robot-deploy` | Explicitly approved backend deployments |

All selectors also require `self-hosted`, `Linux`, `X64`. A missing role label
leaves jobs queued; there is no automatic hosted fallback. Multiple runner names
do not prove there are multiple physical machines. Record their physical-host
mapping, CPU/RAM, free SSD space, network reachability, owner and availability
before assigning roles. Do not use production signaling or database VMs.

**Isolation is a prerequisite, not something YAML labels enforce.** Run each
job in a fresh disposable VM with an ephemeral/JIT runner registration; a
one-job registration alone does not erase the VM. Destroy the VM, writable
disks and Docker state after success, failure, cancellation or timeout using
an external lifecycle controller. Never reuse a PR VM for a trusted job, share
host Docker sockets or writable host/tool/cache mounts across trust boundaries,
or give job users hypervisor/runner-controller credentials. Docker access inside
the disposable guest is privileged; keep it away from the physical host.

Labels and job conditions are routing hints, not access controls: a PR can edit
workflow YAML. Restrict privileged runner access to the approved workflow and
`master` ref using runner-group workflow restrictions where available, or an
external JIT controller that validates repository, workflow and ref before
issuing a runner. If this cannot be enforced for this repository, keep privileged
workers unregistered and do not enable self-hosted PR runs.

Create `production` and `android-release` environments with master-only
deployment rules, required independent reviewers and no self-approval/bypass;
leave `ci` without secrets. Scope deployment SSH/database credentials to
`production` and Android build configuration to `android-release`. Do not leave
equivalent repository-wide secrets accessible to editable PR workflows.
The unchanged hosted originals still use repository secrets, so moving those
secrets requires a coordinated hosted-workflow update at cutover. Until then,
limit evaluation to reviewed manual master runs; do not enable automatic shadow
runs. Keep build VMs blocked from production/private networks and metadata
endpoints. Only the protected deployment guest may reach the required database
and SSH destinations.

#### Reproducible runner image

Provision outside CI, with no unattended privileged installation in a build job:

- Linux x64, Bash, Git, curl, GNU tar/coreutils, gzip/zstd, unzip, Python 3,
  `procps` (`free`), and Node.js 24 from `.nvmrc`.
- Current GitHub Actions runner compatible with `checkout@v7`, `setup-node@v7`,
  `setup-java@v6` and `upload-artifact@v7`; validate action runtime/glibc support
  on the image before registering it. Retain setup actions for version checking.
- Backend workers: Docker Engine 28+ and access to pull `postgres:16`. The copy
  publishes PostgreSQL on a random **loopback-only** port, discovered through
  the service context, not the host's normal 5432. No persistent database volume.
- Android workers: Temurin Java 21, Android command-line/platform tools, SDK
  platform 36, build-tools `36.0.0`, NDK `27.1.12297006`, SDK CMake `3.22.1`
  (including Ninja), accepted SDK licenses, and matching `ANDROID_HOME` and
  `ANDROID_SDK_ROOT`. Keep using the checked-in Gradle wrapper (9.3.1).
- Outbound HTTPS/DNS for GitHub Actions, caches/artifacts, npm, Docker Hub,
  Gradle, Maven Central and Google Android/Maven downloads; verify against
  GitHub's current self-hosted-runner endpoint requirements. No inbound public
  access is needed for build workers.

Start with one active Android guest per physical build host, including release
builds. Keep the spare registration offline until capacity is measured. The
copies cap Gradle and Jest workers at two and bound jobs to 20 minutes (tests/
deploy) or 45 minutes (Android); scheduler VM CPU/memory quotas are still needed.
Each runner processes one job at a time. Monitor queue depth, free disk, memory,
container/process leaks and runner availability; alert on offline or stuck
workers and refresh the image/runner regularly.

#### Cache and cleanup policy

The shared CI action uses fresh directories under `RUNNER_TEMP`, outside the
checkout, and GitHub Actions caches for persistence between disposable VMs.
Caches are exact-keyed by OS/architecture, package/lockfiles and separate `ci`,
`release`, or `deploy` namespaces. GitHub's ref scoping additionally prevents PR
writes from updating master caches. There are no cross-namespace restore
prefixes. Keep caches free of secrets: namespacing is not confidentiality, and
PRs may read default-branch caches.

Only npm's package-content cache and Gradle dependency modules/wrapper
distributions persist. `npm ci` still installs each job; `node_modules`, npm
logs/config, Metro transforms, Gradle task outputs and APKs never enter these
caches. Deliberately do not persist the Gradle build-output cache: environment
values inlined by Babel are not reliable cache inputs. Job-local `--build-cache`
remains enabled without risking a previous run's bundled configuration.

Firebase configuration is removed before generation and in an `always()` cleanup
step; absent secrets produce a non-FCM build rather than reuse an earlier file.
Only master non-PR Android jobs receive release configuration. APK verification
and three-day artifact retention are unchanged. Fresh checkouts/VMs also prevent
stale generated resources or JS bundles. Cleanup steps cannot survive every
runner crash: external VM destruction remains mandatory. Never run broad
host-wide Docker pruning from a job. Set guest disk quotas and cache retention/
size limits; evict old Actions caches through repository cache management,
starting with obsolete namespace versions.

#### Baseline, acceptance and rollback

Hosted observations from 2026-09-11 (single samples, not performance targets):

| Job / run | Scheduling delay¹ | Job duration | npm install | Main work |
| --------- | ----------------- | ------------ | ----------- | --------- |
| Mobile / [34641457244](https://github.com/konarsubhojit/studious-robot/actions/runs/34641457244) | 3 s | 66 s | 19 s | Jest 21 s |
| Android / [34641457128](https://github.com/konarsubhojit/studious-robot/actions/runs/34641457128) | 2 s | 507 s | 22 s | Gradle 433 s |
| Backend tests / [34619081488](https://github.com/konarsubhojit/studious-robot/actions/runs/34619081488) | 3 s | 122 s | 6 s | Tests 74 s |

¹ Job `started_at` minus job `created_at`, not total workflow dependency wait.
The Android log reports npm, Gradle dependency and wrapper cache hits. The
backend run's subsequent hosted deployment failed in production migrations
before SSH; its logs do not identify the underlying database error. Resolve
that existing operational failure separately before validating deployment.

1. Keep hosted merge gates active and `SELF_HOSTED_CI_ENABLED` unset. Provision
   and review runner/environment/controller controls first; manually run tests
   and APK builds without the deployment checkbox.
2. Collect several comparable cold/warm runs at the same commit/toolchain.
   Use job timestamps and step timings plus the new capacity/cache-hit summaries;
   compare end-to-end queue time, resource pressure, failures and artifact
   equivalence, not build time alone. Tune workers only from these measurements.
3. After secret scoping and runner access controls are coordinated, enable
   shadow checks and exercise shared-only/Node-pin changes, PRs (including forks),
   master pushes and non-master manual Android builds. Confirm full tests,
   simultaneous isolated PostgreSQL services, FCM/non-FCM APK checks, no stale
   configuration, cancellation cleanup and denial of PR access to privileged
   workers/environments. Test an offline runner without disabling hosted gates.
4. Validate deployment explicitly on master with environment approval only after
   tests, isolation and connectivity pass. The migration still precedes SSH and
   shares serialization with the live hosted deployment.
5. Cut over in a separate reviewed change: switch required checks to the
   validated self-hosted workflows, retire the hosted automatic builds and
   enable master-push deployment in the self-hosted copy. Never enable two
   automatic deployment paths. No performance improvement or infrastructure
   readiness is claimed until the runner-side measurements pass.

Before cutover, rollback is simply unset/false `SELF_HOSTED_CI_ENABLED` (and stop
manual dispatches); cancel queued self-hosted test/build runs separately. Do not
interrupt an active production migration/deployment. After cutover, restore the
hosted workflows and required-check mapping in a reviewed change before
disabling self-hosted triggers. Job timeouts do not solve missing-label queues.

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
