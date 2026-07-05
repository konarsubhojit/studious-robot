# TCalling — Setup Guide

End-to-end instructions for configuring the signaling server and the React Native mobile app from a fresh checkout.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Server Setup](#server-setup)
   - [Local development](#local-development)
   - [Environment variables](#server-environment-variables)
   - [Database (Postgres / Neon)](#database-postgres--neon)
   - [Redis](#redis)
   - [Push notifications — FCM (Android)](#push-notifications--fcm-android)
   - [Push notifications — APNs (iOS)](#push-notifications--apns-ios)
   - [Deploying to Oracle Ampere A1 VM](#deploying-to-oracle-ampere-a1-vm)
3. [Mobile App Setup](#mobile-app-setup)
   - [Install JS dependencies](#install-js-dependencies)
   - [Environment variables](#mobile-environment-variables)
   - [TURN server configuration](#turn-server-configuration)
   - [Android — Firebase setup](#android--firebase-setup)
   - [Android — Vector icon fonts](#android--vector-icon-fonts)
   - [iOS — Firebase setup](#ios--firebase-setup)
   - [iOS — CallKit entitlement](#ios--callkit-entitlement)
   - [iOS — Vector icon fonts](#ios--vector-icon-fonts)
   - [Running on device / simulator](#running-on-device--simulator)
4. [CI / CD](#ci--cd)
5. [Self-hosted TURN Server](#self-hosted-turn-server)

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 22 (see `.nvmrc`) | Use [nvm](https://github.com/nvm-sh/nvm): `nvm install` |
| npm | bundled with Node | |
| React Native CLI | latest | `npm install -g react-native-cli` |
| Android Studio | latest | For Android emulator / device builds |
| Xcode | ≥ 15 | macOS only, required for iOS builds |
| CocoaPods | ≥ 1.14 | `sudo gem install cocoapods` |
| PostgreSQL | ≥ 15 | Or a managed service like [Neon](https://neon.tech) |
| Redis | ≥ 7 | Or Upstash / self-hosted on the VM |

---

## Server Setup

### Local development

```bash
cd server
npm install
npm run dev        # watch mode (nodemon)
# or
npm start          # production mode
```

The server listens on `PORT` (default **4173**) and exposes:

- `GET /health` — liveness probe
- `GET /metrics` — call funnel counters + latency histograms
- `POST /session` — create / refresh a session token
- WebSocket (Socket.IO) signaling on the same port

### Server environment variables

Create a `.env` file in `server/` (or export in your shell / CI secrets):

```bash
# ── Core ─────────────────────────────────────────────────────────────────────
NODE_ENV=production            # or development
PORT=4173                      # HTTP + WebSocket listen port
HOST=0.0.0.0                   # bind address

# Comma-separated list of allowed CORS origins (mobile app origin or '*' for dev)
CORS_ORIGIN=https://your-app.example.com

# ── Database (Postgres) ──────────────────────────────────────────────────────
# Full connection string, e.g. from Neon:
DATABASE_URL=******host/dbname?sslmode=require

# ── Redis ────────────────────────────────────────────────────────────────────
# When set, session/presence state is Redis-backed (required for multi-instance).
REDIS_URL=redis://localhost:6379

# ── Session ──────────────────────────────────────────────────────────────────
# Token lifetime in milliseconds.  Clients refresh at ~83 % of this interval.
# 0 = infinite (not recommended for production).
SESSION_TTL_MS=3600000         # 1 hour

# ── Rate limiting ────────────────────────────────────────────────────────────
CALL_RATE_LIMIT=10             # max call initiations per window per user
CALL_RATE_WINDOW_MS=60000
RTC_RATE_LIMIT=100             # max RTC relay events per window per user
RTC_RATE_WINDOW_MS=10000

# ── Shutdown ─────────────────────────────────────────────────────────────────
SHUTDOWN_DRAIN_MS=25000        # graceful drain timeout before forced exit

# ── Push — FCM (Android) ─────────────────────────────────────────────────────
# Service-account JSON string (minified).  See "Push notifications — FCM" below.
FCM_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}

# ── Push — APNs (iOS) ────────────────────────────────────────────────────────
# PEM-encoded .p8 key file contents (include the -----BEGIN/END----- lines).
APNS_KEY=-----BEGIN PRIVATE KEY-----\nMIGH...
APNS_KEY_ID=XXXXXXXXXX         # 10-char key ID from Apple Developer portal
APNS_TEAM_ID=XXXXXXXXXX        # 10-char Team ID from Apple Developer portal
APNS_BUNDLE_ID=com.example.tcalling
APNS_PRODUCTION=false          # set to true for App Store / TestFlight builds
```

> **Tip:** All push variables are optional. Missing or malformed values are skipped with a `console.warn`; the server remains fully functional without push.

### Database (Postgres / Neon)

1. Create a Postgres database (local or [Neon free tier](https://neon.tech)).
2. Set `DATABASE_URL` in your environment.
3. Run the Drizzle migrations:

```bash
cd server
npx drizzle-kit migrate
```

The schema lives in `server/db/schema.js`; migrations are in `server/db/migrations/`.

### Redis

Redis is **optional** but strongly recommended for production:

- Enables cross-instance session/presence fan-out via the Socket.IO Redis adapter.
- Persists sessions and presence maps across server restarts.

```bash
# Quick local Redis via Docker
docker run -d -p 6379:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6379
```

For a single-VM deployment Redis is optional (in-memory state is used). Install it locally on the VM or use a managed service such as Upstash. See [Deploying to Oracle Ampere A1 VM](#deploying-to-oracle-ampere-a1-vm) for setup instructions.

### Push notifications — FCM (Android)

1. Open [Firebase Console](https://console.firebase.google.com) → your project → **Project settings** → **Service accounts**.
2. Click **Generate new private key** and download the JSON.
3. Minify the JSON (remove newlines) and set it as `FCM_SERVICE_ACCOUNT_JSON`:

```bash
# Minify using jq
FCM_SERVICE_ACCOUNT_JSON=$(jq -c . < service-account.json)
export FCM_SERVICE_ACCOUNT_JSON
```

> The server uses `google-auth-library` to exchange the service-account credentials for short-lived OAuth 2.0 tokens on each FCM HTTP v1 request.

### Push notifications — APNs (iOS)

1. In [Apple Developer portal](https://developer.apple.com) → **Certificates, Identifiers & Profiles** → **Keys**, create an **APNs** key (type: Apple Push Notifications service).
2. Download the `.p8` file — **you can only download it once**.
3. Note the **Key ID** and your **Team ID** (top-right in the portal).
4. Set the server environment variables:

```bash
APNS_KEY=$(cat AuthKey_XXXXXXXXXX.p8)   # full PEM contents, newlines as \n
APNS_KEY_ID=XXXXXXXXXX
APNS_TEAM_ID=XXXXXXXXXX
APNS_BUNDLE_ID=com.example.tcalling     # must match your app's Bundle Identifier
APNS_PRODUCTION=false                    # true for production / TestFlight
```

### Deploying to Oracle Ampere A1 VM

The signaling server runs as a **systemd service** on an Oracle Cloud Ampere A1 (arm64) instance. Automated deploys are handled by the `backend-ci.yml` GitHub Actions workflow, which SSHes into the VM on every push to `master` and runs a git-pull + npm-ci + service-restart.

**One-time VM setup** is covered in detail in [`deploy/README.md`](./deploy/README.md). The condensed steps are:

1. **Provision** an Oracle Cloud Ampere A1 VM (Oracle Linux or Ubuntu) and note its public IP.
2. **Install Node.js 24** (matching `.nvmrc`) via the NodeSource repo:

   ```bash
   # Oracle Linux
   curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
   sudo dnf install -y nodejs
   ```

3. **Clone the repo** and install production dependencies:

   ```bash
   mkdir -p ~/repos
   git clone https://github.com/konarsubhojit/studious-robot.git ~/repos/studious-robot
   cd ~/repos/studious-robot/server && npm ci --omit=dev
   ```

4. **Install the systemd unit** from `deploy/robot-signal.service`:

   ```bash
   sudo cp ~/repos/studious-robot/deploy/robot-signal.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now robot-signal
   ```

5. **Open port 4173** in both the OCI Security List and the VM host firewall:

   ```bash
   # Oracle Linux (firewalld)
   sudo firewall-cmd --permanent --add-port=4173/tcp && sudo firewall-cmd --reload
   ```

6. **Add a TLS reverse proxy** (Caddy recommended) so the app can use `wss://`:

   ```caddy
   # /etc/caddy/Caddyfile
   signal.yourdomain.com {
       reverse_proxy 127.0.0.1:4173
   }
   ```

7. **Add GitHub secrets** for automated deploys:

   | Secret | Description |
   |--------|-------------|
   | `DEPLOY_SSH_KEY` | Private key for the deploy SSH key pair |
   | `DEPLOY_SSH_HOST` | VM public IP or hostname |
   | `DEPLOY_SSH_USER` | VM user (`opc` on Oracle Linux) |
   | `DEPLOY_SSH_PORT` | SSH port (optional, defaults to `22`) |
   | `DATABASE_URL_DIRECT` | Neon direct Postgres URL for CI migrations |
   | `FCM_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON for FCM push |

See [`deploy/README.md`](./deploy/README.md) for the full walkthrough including TLS options, sudoers configuration, Redis setup, and OCI networking details.

---

## Mobile App Setup

### Install JS dependencies

```bash
cd mobile
npm install
```

### Mobile environment variables

The mobile app uses `babel-plugin-transform-inline-environment-variables` to bake env vars into the JS bundle at **build time**. Export them before running Metro / Gradle / Xcode:

```bash
export SIGNALING_URL=wss://your-server.example.com   # WebSocket URL of the server
export ROOM_ID=default-room                           # legacy room ID (can be any string)
export TURN_USERNAME=your-turn-username               # TURN relay credentials
export TURN_CREDENTIAL=your-turn-credential
```

> **Note:** `TURN_URL` (optional) is read at runtime via `process.env` — you can set it at build time the same way. See [TURN server configuration](#turn-server-configuration) for details.

For CI, store these as repository secrets (`SIGNALING_URL`, `ROOM_ID`, `TURN_USERNAME`, `TURN_CREDENTIAL`) — both Android and iOS workflows consume them automatically.

### TURN server configuration

TURN relay is required for calls across symmetric NAT (most corporate / mobile carrier networks). Two providers are supported:

**Option A — Metered.ca (recommended for quick start)**

No `TURN_URL` needed; just provide credentials:

```bash
export TURN_USERNAME=your-metered-username
export TURN_CREDENTIAL=your-metered-credential
```

**Option B — Self-hosted coturn**

```bash
export TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
export TURN_USERNAME=youruser
export TURN_CREDENTIAL=yourpassword
```

See [Self-hosted TURN Server](#self-hosted-turn-server) for coturn setup instructions.

**Diagnostics**

At app startup, `getTurnDiagnostics()` logs a `console.warn` if no TURN credentials are configured and STUN-only mode is active. This appears in Metro logs and device logs.

### Android — Firebase setup

1. Open [Firebase Console](https://console.firebase.google.com) → **Project settings** → **Your apps** → Add / select your Android app.
2. Set the package name to match `android/app/build.gradle` (`applicationId`).
3. Download **`google-services.json`** and place it at:

   ```
   mobile/android/app/google-services.json
   ```

4. Confirm `android/build.gradle` contains the Google Services classpath:

   ```groovy
   classpath("com.google.gms:google-services:4.4.2")
   ```

5. Confirm `android/app/build.gradle` applies the plugin:

   ```groovy
   apply plugin: "com.google.gms.google-services"
   ```

The `@react-native-firebase/app` and `@react-native-firebase/messaging` packages are already listed in `package.json` and wired into `mobile/index.js` as a background message handler.

### Android — Vector icon fonts

`react-native-vector-icons` requires the Material Community Icons font to be copied into the Android assets during the build:

1. Open `android/app/build.gradle` and add inside the `android { ... }` block:

```groovy
apply from: file("../../node_modules/react-native-vector-icons/fonts.gradle")
```

2. Rebuild the app:

```bash
cd mobile/android && ./gradlew assembleDebug
```

If the font is missing at runtime, `IconButton` degrades to emoji icons automatically.

### iOS — Firebase setup

1. In [Firebase Console](https://console.firebase.google.com) → **Project settings** → **Your apps** → Add / select your iOS app.
2. Set the Bundle ID to match Xcode (default: `org.reactjs.native.example.StudiousRobot`).
3. Download **`GoogleService-Info.plist`** and place it at:

   ```
   mobile/ios/StudiousRobot/GoogleService-Info.plist
   ```

4. In Xcode, drag `GoogleService-Info.plist` into the `StudiousRobot` target group, ensuring **Copy items if needed** and the correct target membership are selected.

5. In **Xcode → Signing & Capabilities**, enable **Push Notifications** and **Background Modes → Remote notifications**.

6. Register for APNs in the Apple Developer portal (see [Push notifications — APNs](#push-notifications--apns-ios)) and upload the `.p8` key to the server.

### iOS — CallKit entitlement

CallKit displays native incoming-call UI and integrates with the system phone app.

1. In Xcode, select your target → **Signing & Capabilities** → **+ Capability** → **VoIP Push Notifications**.
2. The `react-native-callkeep` package (already in `package.json`) handles CallKit registration automatically when a session starts.

> **Note:** CallKit requires a real device; it is silently disabled in the iOS Simulator.

### iOS — Vector icon fonts

1. In Xcode, open the project, then select **File → Add Files to "StudiousRobot"**.
2. Navigate to `mobile/node_modules/react-native-vector-icons/Fonts/` and add `MaterialCommunityIcons.ttf` to your target.
3. Open `ios/StudiousRobot/Info.plist` and add the font to `UIAppFonts`:

```xml
<key>UIAppFonts</key>
<array>
  <string>MaterialCommunityIcons.ttf</string>
</array>
```

4. Clean and rebuild (`Cmd + Shift + K`, then `Cmd + B`).

If the font file is missing at runtime, `IconButton` degrades to emoji icons automatically.

### Running on device / simulator

**Android**

```bash
cd mobile
# Start Metro bundler (separate terminal)
npx react-native start

# Build and install on connected device or emulator
npx react-native run-android
```

**iOS**

```bash
cd mobile
# Install CocoaPods (first time or after native dependency changes)
cd ios && pod install && cd ..

# Start Metro bundler (separate terminal)
npx react-native start

# Build and run on simulator
npx react-native run-ios

# Run on a specific simulator
npx react-native run-ios --simulator="iPhone 16"
```

---

## CI / CD

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `mobile-ci.yml` | push/PR to `master` touching `mobile/` | Runs Jest unit tests on Ubuntu |
| `android-apk.yml` | push/PR + `workflow_dispatch` | Builds debug (PR) + debug+release (push) APKs |
| `backend-ci.yml` | push/PR touching `server/` | Runs server unit tests; deploys to Oracle Ampere A1 VM on `master` push |

**Required GitHub secrets** (set in repo Settings → Secrets and variables → Actions):

| Secret | Used by | Description |
|--------|---------|-------------|
| `SIGNALING_URL` | Android, iOS | WebSocket URL baked into the JS bundle |
| `ROOM_ID` | Android, iOS | Legacy room ID |
| `TURN_USERNAME` | Android, iOS | TURN relay username |
| `TURN_CREDENTIAL` | Android, iOS | TURN relay credential |
| `DEPLOY_SSH_KEY` | backend-ci | Private key for SSH deploy to Oracle VM |
| `DEPLOY_SSH_HOST` | backend-ci | Oracle VM public IP or hostname |
| `DEPLOY_SSH_USER` | backend-ci | VM user (`opc` on Oracle Linux) |
| `DEPLOY_SSH_PORT` | backend-ci | SSH port (optional, defaults to `22`) |
| `DATABASE_URL_DIRECT` | backend-ci | Neon direct Postgres URL for CI migrations |
| `FCM_SERVICE_ACCOUNT_JSON` | backend-ci | Firebase service-account JSON for FCM push |

---

## Self-hosted TURN Server

[coturn](https://github.com/coturn/coturn) is the most widely used open-source TURN implementation.

### Quick install (Ubuntu / Debian)

```bash
sudo apt update && sudo apt install -y coturn

# Enable the service
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

### Minimal `/etc/turnserver.conf`

```ini
# Listening ports
listening-port=3478
tls-listening-port=5349

# Replace with your server's public IP or FQDN
external-ip=YOUR_PUBLIC_IP
realm=turn.example.com

# TLS certificate (Let's Encrypt recommended)
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# Static credentials (long-term)
lt-cred-mech
user=youruser:yourpassword

# Logging
log-file=/var/log/turnserver.log
```

```bash
sudo systemctl restart coturn
```

### Mobile app configuration

```bash
export TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
export TURN_USERNAME=youruser
export TURN_CREDENTIAL=yourpassword
```

### Firewall rules

Open these ports on the TURN server's firewall / security group:

| Port | Protocol | Purpose |
|------|----------|---------|
| 3478 | TCP + UDP | TURN / STUN |
| 5349 | TCP + UDP | TURN over TLS |
| 49152–65535 | UDP | Relay media (coturn default ephemeral range) |
