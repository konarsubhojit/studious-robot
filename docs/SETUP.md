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
   - [Deploying to a VM (GCP + Ubuntu)](#deploying-to-a-vm-gcp--ubuntu)
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
- `GET /metrics` — call funnel counters, latency histograms, and per-operation
  SQL/Redis query timings (see *Query timing* below). Requires
  `x-debug-token` to match `DEBUG_API_TOKEN`.
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

# Required to read GET /metrics via x-debug-token
DEBUG_API_TOKEN=replace-with-a-strong-random-token

# ── Database (Postgres) ──────────────────────────────────────────────────────
# Full connection string, e.g. from Neon:
DATABASE_URL=******host/dbname?sslmode=require
# Per-instance pool size (divide Neon pooled budget by instance count):
DB_POOL_SIZE=4

# ── Redis ────────────────────────────────────────────────────────────────────
# REQUIRED in the deployed topology (two signaling VMs): it is what makes
# sessions, presence, call state, the read cache and socket fan-out shared
# rather than private to each VM.  Optional for local single-process work.
REDIS_URL=redis://localhost:6379

# Distinct ordinal per instance.  Nothing sets this automatically across
# separate hosts, and it is what arms the "multi-instance without Redis" guard.
INSTANCE_ID=0

# ── Session ──────────────────────────────────────────────────────────────────
# Token lifetime in milliseconds.  Defaults to 7 days when unset; the client
# re-mints transparently on a 401 or a `session.invalid` socket event.
# 0 = infinite (leaks one immortal bearer token per login; tests only).
# SESSION_TTL_MS=3600000       # 1 hour

# ── Postgres retention ───────────────────────────────────────────────────────
# `calls`, `call_events` and `audit_log` are append-only. The retention sweep
# is what bounds them — and, because boot hydration reads `calls`, what keeps
# startup from growing with history. Only *terminal* calls are eligible;
# `call_events` cascades with its call. 0 disables that table's sweep.
# DB_CALL_RETENTION_MS=7776000000   # 90 days (default)
# AUDIT_RETENTION_MS=15552000000    # 180 days (default)

# ── Rate limiting ────────────────────────────────────────────────────────────
CALL_RATE_LIMIT=10             # max call initiations per window per user
CALL_RATE_WINDOW_MS=60000
RTC_RATE_LIMIT=100             # max RTC relay events per window per user
RTC_RATE_WINDOW_MS=10000
MESSAGE_RATE_LIMIT=30          # max chat sends per window per user
MESSAGE_RATE_WINDOW_MS=60000

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

# ── Message store ───────────────────────────────────────────────────────────
# Chat history lives in the `messages` table of the same Postgres database as
# everything else, so DATABASE_URL above is all the configuration it needs.
# Production fails closed without it. Only set this when ephemeral chat history
# is an intentional operational choice:
ALLOW_IN_MEMORY_MESSAGE_STORE=false

# ── Chat attachments (Cloudflare R2) ────────────────────────────────────────
# When set, clients can upload photos, files and voice notes through presigned
# R2 URLs. Everything is stored under the shared `chatblobs/` prefix, and only
# URLs under `<R2_PUBLIC_BASE_URL>/chatblobs/` are accepted on `message.send`.
# Leave unset to keep chat text-only: /attachments/presign then answers 503.
R2_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_BUCKET=wetalk-chat
R2_ACCESS_KEY_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
R2_PUBLIC_BASE_URL=https://media.example.com   # bucket's public/CDN origin
# R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com  # optional override
R2_PRESIGN_TTL_SECONDS=300     # optional, default shown (max 3600)

# ── Query timing (SQL / Redis) ──────────────────────────────────────────────
# Every datastore round trip is timed, counted per operation on GET /metrics,
# and logged to the console. Queries at/over the slow threshold are logged as
# warnings; the rest are logged only when VERBOSE_LOGGING / LOG_LEVEL=debug.
DB_QUERY_TIMING=true           # optional, default shown (false disables timing)
DB_SLOW_QUERY_MS=100           # Postgres slow-query threshold, default shown
REDIS_SLOW_QUERY_MS=100        # Redis cache slow-query threshold, default shown
```

> **Tip:** APNs and Notification Hub variables are optional.
> `FCM_SERVICE_ACCOUNT_JSON` is required because the server also uses it to
> verify Firebase authentication tokens.

### Database (Postgres / Neon)

1. Create a Postgres database (local or [Neon free tier](https://neon.tech)).
2. Set `DATABASE_URL` in your environment.
3. Run the Drizzle migrations:

```bash
cd server
npx drizzle-kit migrate
```

The schema lives in `server/db/schema.ts`; migrations are in `server/db/migrations/`.

### Query timing

Every Postgres and Redis round trip is measured and reported in two places:

- **Server console.** A query at or over the slow threshold (default **100 ms**)
  logs `[db-timing] SLOW backend=… op=… kind=read|write target=… durationMs=…`,
  as does every failed query. Set `VERBOSE_LOGGING=true` (or `LOG_LEVEL=debug`)
  to log *every* query through the redacting verbose logger instead of only the
  slow ones. Only the shape of a query is ever logged — never statement
  parameters or message bodies.
- **`GET /metrics`.** `counters.db_*` give the totals (queries, reads, writes,
  slow, errors), `histograms.{pg,redis}_query_duration_ms` give the
  latency distribution, and `dbQueries` lists every operation sorted by total
  time spent — so the costliest operation is the first row:

```json
{
  "dbQueries": [
    { "backend": "pg", "operation": "select", "kind": "read",
      "count": 42, "errors": 0, "slow": 3, "totalMs": 5120, "meanMs": 121.9, "maxMs": 480.2 },
    { "backend": "pg", "operation": "insert", "kind": "write",
      "count": 190, "errors": 0, "slow": 0, "totalMs": 812, "meanMs": 4.27, "maxMs": 31.5 }
  ]
}
```

The Android app pulls the same snapshot into its **Export Logs** file, so the
exported `wetalk-logs-*.txt` ends with a `--- server query timings ---` table
(and says why when the server is unreachable).

### Redis

Redis is required for multi-instance signaling and optional for single-instance:

- Enables cross-instance session/presence fan-out via the Socket.IO Redis adapter.
- Persists sessions and presence maps across server restarts.

Both are required by the deployed topology (two signaling VMs). A single local
process may omit `REDIS_URL`, where `/health` reports `stateAffinity: "sticky"`
and the in-memory bus and cache are equivalent.

```bash
# Quick local Redis via Docker
docker run -d -p 6379:6379 redis:7-alpine
export REDIS_URL=redis://localhost:6379
```

For multi-instance deployment, verify `/health` returns `stateAffinity: "shared"`
before switching nginx to round-robin (no `ip_hash`).

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

### Message store

Chat message history and conversation lists (`server/src/messageStore.ts`) live
in the `messages` table of the **same Postgres database** as users, devices and
calls. No extra configuration is needed: if `createServer` gets a `db` handle,
messages are durable. Without one the server falls back to an in-memory store,
which production refuses unless `ALLOW_IN_MEMORY_MESSAGE_STORE=true` says the
loss of history on restart is intentional.

`saveMessage` inserts with `ON CONFLICT (conversation_id, message_id) DO
NOTHING`, so a client replaying a send from its outbox can never create a second
message — and, because the conflicting insert is discarded rather than applied,
never overwrites the reactions and receipts the original has since accumulated.

Search (`GET /messages/search`) is a literal, case-insensitive substring match,
served by a `pg_trgm` GIN index on `lower(body)`. Migration `0010` creates the
extension, so it must run with the owner connection — `DATABASE_URL_DIRECT`,
which `drizzle.config.ts` already prefers.

> Chat history used to live in a separate MongoDB/Cosmos deployment. It was
> consolidated into Postgres: the second datastore bought nothing that a table
> and five indexes do not, while costing a second connection pool, a second
> backup story, and a hand-maintained `conversation_index` collection that could
> silently disagree with the messages it summarised.

### Deploying to a VM (GCP + Ubuntu)

The verified reference deployment is a **GCP e2-micro** instance running
**Ubuntu**, with the signaling server as a **systemd service** listening on
`0.0.0.0:4173` behind an **nginx** reverse proxy, **DuckDNS** for dynamic DNS,
and **certbot/Let's Encrypt** (`certbot.timer`) for TLS. Automated deploys are
handled by the `backend-ci.yml` GitHub Actions workflow, which SSHes into the
VM on every push to `master` and runs a git-pull + npm-ci + service-restart.

> Oracle Cloud Ampere A1 (arm64) + `opc` user + firewalld + Caddy also works
> and remains documented as an alternative — see
> [`deploy/README.md`](../deploy/README.md) for both paths.

**One-time VM setup** is covered in detail in [`deploy/README.md`](../deploy/README.md). The condensed steps for the GCP + Ubuntu path are:

1. **Provision** a GCP e2-micro VM (Ubuntu) and note its public IP, or point a **DuckDNS** hostname at it.
2. **Install Node.js 24** (matching `.nvmrc`) via the NodeSource repo:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Clone the repo** and install production dependencies:

   ```bash
   mkdir -p ~/repos
   git clone https://github.com/konarsubhojit/studious-robot.git ~/repos/studious-robot
   cd ~/repos/studious-robot/server && npm ci --omit=dev
   ```

4. **Install the systemd unit** from `deploy/robot-signal.service` (the unit ships with `User=ubuntu`; adjust it — and `WorkingDirectory=`, which must be an absolute path, not `%h/...` — if your VM user differs, e.g. `opc` on Oracle Linux):

   ```bash
   sudo cp ~/repos/studious-robot/deploy/robot-signal.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now robot-signal
   ```

5. **Open port 4173** (or `443` once nginx is fronting it) in the VM's firewall / cloud network rules (GCP firewall rules; OCI Security List + firewalld/iptables on Oracle).

6. **Add nginx as a TLS-terminating reverse proxy**, with certbot managing the certificate:

   ```nginx
   # /etc/nginx/sites-available/robot-signal
   server {
       listen 443 ssl;
       server_name yourname.duckdns.org;

       location / {
           proxy_pass http://127.0.0.1:4173;
           # Required for Socket.IO WebSocket transport:
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
       }
   }
   ```

   ```bash
   sudo certbot --nginx -d yourname.duckdns.org
   # certbot installs a certbot.timer systemd unit that auto-renews the cert.
   ```

7. **Add GitHub secrets** for automated deploys:

   | Secret | Description |
   |--------|-------------|
   | `DEPLOY_SSH_KEY` | Private key for the deploy SSH key pair |
   | `DEPLOY_SSH_HOST` | VM public IP or hostname |
   | `DEPLOY_SSH_USER` | VM user (`ubuntu` on GCP; `opc` on Oracle Linux) |
   | `DEPLOY_SSH_PORT` | SSH port (optional, defaults to `22`) |
   | `DATABASE_URL_DIRECT` | Neon direct Postgres URL for CI migrations |
   | `FCM_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON for FCM push |

See [`deploy/README.md`](../deploy/README.md) for the full walkthrough including TLS options, sudoers configuration, Redis setup, and firewall/networking details for both GCP and OCI.

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

**Option C — Server-minted credentials (recommended for self-hosted coturn)**

No mobile-side TURN env vars at all: configure `TURN_URL` +
`TURN_STATIC_AUTH_SECRET` (and optionally `TURN_TTL_SECONDS`) on the signaling
server and it hands out per-user, time-limited HMAC credentials at
`GET /turn-credentials`. See [HMAC credentials](#hmac-credentials-recommended).

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

The `@react-native-firebase/app` and `@react-native-firebase/messaging` packages are already listed in `package.json` and wired into `mobile/index.tsx` as a background message handler.

### Android — Vector icon fonts

`react-native-vector-icons` requires the Material Community Icons font to be
copied into the Android assets during the build. **This is now wired up
automatically** — `android/app/build.gradle` applies the packaged
`fonts.gradle` and bundles `MaterialCommunityIcons.ttf` into the APK:

```groovy
project.ext.vectoricons = [
    iconFontNames: ['MaterialCommunityIcons.ttf'],
]
apply from: file("../../node_modules/react-native-vector-icons/fonts.gradle")
```

No manual step is required; just rebuild the app:

```bash
cd mobile/android && ./gradlew assembleDebug
```

To confirm the font is actually inside a built APK:

```bash
unzip -l app-release.apk | grep assets/fonts/MaterialCommunityIcons.ttf
```

The Android APK CI workflow performs this same check on every build. If the
font is ever missing at runtime, `IconButton` degrades to emoji icons
automatically.

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

`MaterialCommunityIcons.ttf` is already declared in
`ios/StudiousRobot/Info.plist` under `UIAppFonts`:

```xml
<key>UIAppFonts</key>
<array>
  <string>MaterialCommunityIcons.ttf</string>
</array>
```

You still need to add the font file to the Xcode target so it ships in the app
bundle:

1. In Xcode, open the project, then select **File → Add Files to "StudiousRobot"**.
2. Navigate to `mobile/node_modules/react-native-vector-icons/Fonts/` and add `MaterialCommunityIcons.ttf` to your target.
3. Clean and rebuild (`Cmd + Shift + K`, then `Cmd + B`).

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

The configuration below uses **`use-auth-secret`** (time-limited HMAC credentials),
which is the recommended mode — see [HMAC credentials](#hmac-credentials-recommended).

```ini
# Listening ports
listening-port=3478
tls-listening-port=5349

# Relay media port range (must match the firewall rules below)
min-port=49152
max-port=65535

# Replace with your server's public IP or FQDN
external-ip=YOUR_PUBLIC_IP
realm=turn.example.com

# TLS certificate (Let's Encrypt recommended)
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem

# Time-limited HMAC credentials (must match TURN_STATIC_AUTH_SECRET on the server)
use-auth-secret
static-auth-secret=YOUR_LONG_RANDOM_SECRET

# Never relay to internal networks (SSRF / internal port-scan protection)
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=127.0.0.0-127.255.255.255

# Logging
log-file=/var/log/turnserver.log
```

```bash
sudo systemctl restart coturn
```

Generate the secret with `openssl rand -hex 32` and keep it only on the coturn host
and the signaling server.

For long-term (static) credentials instead, replace the `use-auth-secret` /
`static-auth-secret` lines with:

```ini
lt-cred-mech
user=youruser:yourpassword
```

### TLS certificate renewal

coturn loads its certificate at start-up, so it must be restarted after each
certbot renewal:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn.sh >/dev/null <<'EOF'
#!/bin/sh
systemctl restart coturn
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
```

### HMAC credentials (recommended)

<a id="hmac-credentials-recommended"></a>

Set these on the **signaling server** (not the mobile build) so it mints
per-user, time-limited credentials at `GET /turn-credentials`:

```bash
export TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
export TURN_STATIC_AUTH_SECRET=YOUR_LONG_RANDOM_SECRET   # same value as static-auth-secret
export TURN_TTL_SECONDS=3600                             # optional, defaults to 3600
```

The server returns `username=<unix-expiry>:<userId>` and
`credential=base64(HMAC-SHA1(secret, username))`, exactly what coturn's
`use-auth-secret` mode validates, along with an
`X-Turn-Credential-Expires-At` response header the app uses to refresh before
expiry.

Prefer this over static credentials: a static `TURN_USERNAME` / `TURN_CREDENTIAL`
pair is compiled into the app, never expires, and can be extracted from the
binary and abused for free relay bandwidth. HMAC credentials are scoped to one
user and expire after `TURN_TTL_SECONDS`.

Credential tier precedence on the server is **Cloudflare → HMAC → static → STUN-only**.
If `TURN_STATIC_AUTH_SECRET` is set but `TURN_URL` is missing, the server logs a
warning and falls back to the static tier.

### Mobile app configuration (static credentials fallback)

Only needed when the signaling server does not mint credentials:

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
