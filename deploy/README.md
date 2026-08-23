# studious-robot — VM Deployment Guide

This document covers the **one-time VM setup** and explains how the automated SSH deploy works.

The **verified reference deployment** is a **GCP e2-micro** instance running **Ubuntu**, with the service user `ubuntu`, an **nginx** reverse proxy, **DuckDNS** dynamic DNS, and **certbot/Let's Encrypt** (`certbot.timer`) for TLS. An **Oracle Cloud Infrastructure (OCI) Ampere A1** VM with Oracle Linux, user `opc`, firewalld, and Caddy is also documented and supported as an alternative — sections below call out where the two paths differ.

---

## Architecture overview

```
GitHub Actions (push to master)
  └─► appleboy/ssh-action → VM (GCP e2-micro/Ubuntu, or OCI Ampere A1/Oracle Linux)
          ├─ git fetch / reset
          ├─ npm ci --omit=dev
          └─ sudo systemctl reload-or-restart robot-signal
```

The `studious-robot` Node.js signaling server runs as a **systemd service** on the VM, managed by the unit file at `deploy/robot-signal.service`, and is fronted by a TLS-terminating reverse proxy (nginx on the reference GCP deployment, Caddy on OCI).

---

## 1. Prerequisites

- A VM running Ubuntu (reference: **GCP e2-micro**) or Oracle Linux/Ubuntu (OCI Ampere A1, arm64).
- A domain name (or a free **DuckDNS** subdomain) pointing at the VM's public IP (required for TLS; see §9).

---

## 2. Install Node 24

This repository pins **Node 24** via `.nvmrc`. Install it system-wide so `systemd` can find it at `/usr/bin/node`.

### Ubuntu (GCP reference deployment)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

### Oracle Linux (dnf)

```bash
# Enable the NodeSource repo for Node 24
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs
node --version   # should print v24.x.x
```

If `node` ends up at a path other than `/usr/bin/node`, update `ExecStart` in `deploy/robot-signal.service` accordingly (e.g. `/usr/local/bin/node`).

---

## 3. Clone the repository

```bash
mkdir -p ~/repos
git clone https://github.com/konarsubhojit/studious-robot.git ~/repos/studious-robot
```

> **Repo path:** `~/repos/studious-robot`  
> **Service user:** `ubuntu` (GCP/Ubuntu reference default) or `opc` (Oracle Linux default) — set `User=` in the unit file to match, and see §5's note on `WorkingDirectory=`.

---

## 4. Install production dependencies

```bash
cd ~/repos/studious-robot/server
npm ci --omit=dev
```

---

## 5. Install the systemd unit

The shipped `deploy/robot-signal.service` defaults to `User=ubuntu` and `WorkingDirectory=/home/ubuntu/repos/studious-robot/server` (the GCP/Ubuntu reference layout). **Before installing it**, edit both if your VM's user or repo path differs (e.g. `User=opc` and `WorkingDirectory=/home/opc/repos/studious-robot/server` on Oracle Linux):

> `WorkingDirectory=%h/...` does **not** work in a system unit — `%h` resolves to `/root` there regardless of `User=`, not the service user's home directory. Always use an absolute path.

```bash
sudo cp ~/repos/studious-robot/deploy/robot-signal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now robot-signal
sudo systemctl status robot-signal
```

The service listens on `PORT=4173` by default. For real configuration (secrets, per-deployment overrides), create `/etc/robot-signal/env` — the unit's `EnvironmentFile=-/etc/robot-signal/env` loads it automatically, and being declared *after* the unit's own `Environment=` lines, values there win for any key set in both places. Avoid setting the same key in both `Environment=` and the env file; if you do, remember the env file wins. Then reload:

```bash
sudo systemctl daemon-reload && sudo systemctl restart robot-signal
```

### Cloudflare TURN credentials

Set these server-side systemd environment variables to mint short-lived TURN
credentials for authenticated mobile calls:

```ini
Environment=CLOUDFLARE_TURN_KEY_ID=<cloudflare-turn-key-id>
Environment=CLOUDFLARE_TURN_API_TOKEN=<cloudflare-api-token>
# Optional; defaults to 3600 seconds.
Environment=CLOUDFLARE_TURN_TTL_SECONDS=3600
```

Do not put these values in the mobile build. Short-lived credentials prevent a
public APK from exposing a reusable TURN relay secret. `TURN_USERNAME` and
`TURN_CREDENTIAL` are deprecated but remain supported as a server-side fallback;
when neither Cloudflare nor static credentials are set, the server returns
STUN-only configuration.

### Self-hosted coturn HMAC credentials

When using `TURN_STATIC_AUTH_SECRET`, coturn must use the matching TURN REST
authentication mode rather than look up the generated
`<unix-expiry>:<user-id>` username in its SQLite user database. Set the same
random value in `/etc/robot-signal/env` and `/etc/turnserver.conf`:

```ini
# /etc/robot-signal/env
TURN_URL=turn:turn.example.com:3478,turns:turn.example.com:5349
TURN_STATIC_AUTH_SECRET=YOUR_LONG_RANDOM_SECRET
TURN_TTL_SECONDS=3600
```

```ini
# /etc/turnserver.conf
lt-cred-mech
use-auth-secret
static-auth-secret=YOUR_LONG_RANDOM_SECRET
```

Generate the secret with `openssl rand -hex 32`, restrict both files to root,
and restart both services after changing it:

```bash
sudo chmod 600 /etc/robot-signal/env /etc/turnserver.conf
sudo systemctl restart coturn robot-signal
```

`check_stun_auth: Cannot find credentials of user <timestamp:user>` means
coturn is still using its SQLite/static-user lookup for a server-minted
credential. Ensure `use-auth-secret` and the matching `static-auth-secret`
are present in the active coturn configuration; `userdb` entries do not
configure TURN REST authentication.

### Graceful shutdown & rolling deploys

The server installs `SIGTERM`/`SIGINT` handlers and shuts down gracefully:

1. `/health` starts returning **`503 { "status": "draining" }`** so load balancers / reverse proxies stop routing new traffic to the instance.
2. Connected Socket.IO clients receive a **`server.draining`** event so they can reconnect (to another instance, once horizontal scaling lands).
3. New socket connections are rejected while draining; the server waits up to `SHUTDOWN_DRAIN_MS` (default **25s**) for in-flight connections to drain, then force-closes the sockets and HTTP server and closes any durable stores.

The systemd unit is configured for this with:

```ini
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30
```

`KillMode=mixed` sends `SIGTERM` to the main process first (triggering the drain) and only escalates to `SIGKILL` for any survivors after `TimeoutStopSec`. Keep `TimeoutStopSec` **≥ `SHUTDOWN_DRAIN_MS`** (set `Environment=SHUTDOWN_DRAIN_MS=25000` to tune the drain window).

Because shutdown is graceful, the deploy step uses **`systemctl reload-or-restart`** instead of a hard `restart`, which lets in-flight calls drain during a redeploy and starts the service if it was stopped. For a multi-instance (true rolling) setup, restart instances one at a time behind the load balancer, waiting for each `/health` to return `200` before moving to the next.

---

## 6. Create the deploy SSH key pair

The CI workflow SSHes into the VM as your chosen deploy user (`ubuntu` on the GCP reference deployment, `opc` on Oracle Linux) to run the deploy script. Create a **dedicated deploy key** (do not reuse your personal key).

```bash
# On your local machine (or the VM — keep the private key off the VM)
ssh-keygen -t ed25519 -C "studious-robot-deploy" -f ~/.ssh/studious_robot_deploy
```

**Add the public key to the VM:**

```bash
# On the VM, as the deploy user (ubuntu / opc)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "<paste contents of studious_robot_deploy.pub>" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

**Add the following secrets to the GitHub repository**  
*(Settings → Secrets and variables → Actions → New repository secret)*

| Secret name         | Value                                           |
|---------------------|-------------------------------------------------|
| `DEPLOY_SSH_KEY`    | Private key (`~/.ssh/studious_robot_deploy`)    |
| `DEPLOY_SSH_HOST`   | VM public IP or hostname                        |
| `DEPLOY_SSH_USER`   | `ubuntu` (GCP reference) or `opc` (Oracle Linux) |
| `DEPLOY_SSH_PORT`   | SSH port — **optional**, defaults to `22`       |
| `DATABASE_URL_DIRECT` | Neon **direct (unpooled)** Postgres URL — used by the deploy job to run migrations before restart. **Optional**; migrations are skipped when unset. |
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase service-account JSON for FCM HTTP v1 push delivery. **Optional**; FCM pushes are skipped when unset. |

> **`RENDER_DEPLOY_HOOK_URL` is no longer used** — the Render deploy step has been removed. You can delete that secret from the GitHub repository settings.

### Push notifications (FCM HTTP v1) configuration

Incoming-call pushes to offline callees use the **FCM HTTP v1 API** with an
OAuth2 service account (the deprecated legacy server-key API is no longer used).

1. In the Firebase console: **Project settings → Service accounts → Generate new
   private key** to download the service-account JSON.
2. Add the JSON as the `FCM_SERVICE_ACCOUNT_JSON` GitHub Actions secret (or store
   it in your secret manager of choice) and surface it to the server process —
   either as the raw JSON in the `FCM_SERVICE_ACCOUNT_JSON` env var, or by
   writing it to a file on the VM and pointing the env var at that path.
3. Never commit the key. The server mints and caches a short-lived OAuth2 token
   from the key automatically; if the secret is absent FCM delivery is skipped.

APNs uses token auth via the `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_BUNDLE_ID` (and optional `APNS_PRODUCTION`) env vars.

### Database (Neon Postgres) configuration

Durable persistence uses Drizzle ORM over Postgres. Provision a Neon project and
note its two connection strings:

- **Pooled** endpoint (`...-pooler.neon.tech`) → set as `DATABASE_URL` in the
  systemd unit's `Environment=` lines; used by the running server.
- **Direct (unpooled)** endpoint → set as the `DATABASE_URL_DIRECT` GitHub
  secret; used by `npm run db:migrate` in the deploy job (Neon's pooled
  PgBouncer can't run migration DDL/advisory locks).

The deploy workflow runs `npm run db:migrate` (against `DATABASE_URL_DIRECT`) on
the GitHub runner **before** restarting the service, so the schema is up to date
when the new code starts. `drizzle-kit` is a dev dependency and is intentionally
not installed on the VM (`npm ci --omit=dev`); migrations therefore run from CI,
not on the VM.

### Redis (horizontal scaling) configuration — optional

A single VM instance does **not** need Redis. Redis is only required to run more
than one server instance (multiple processes/VMs behind a load balancer), where
it provides:

- a **Pub/Sub message bus** for cross-instance call-state events and cache
  invalidations,
- a **shared read cache** for conversation lists, first-page chat history and
  call history (see `server/src/cache.ts`), and
- the **Socket.IO Redis adapter** so a user's WebSocket events are delivered
  regardless of which instance holds their socket.

Provision Redis and point the server at it with the `REDIS_URL` env var:

- **Self-hosted on the VM** (simplest for a small deployment):

  ```bash
  # Oracle Linux
  sudo dnf install -y redis
  sudo systemctl enable --now redis
  # Bind to localhost only (default) and set REDIS_URL=redis://127.0.0.1:6379
  ```

- **Managed** (OCI Cache / Redis Cloud / Upstash): create an instance and use the
  provider's `rediss://…` URL (TLS).

Then add `Environment=REDIS_URL=redis://127.0.0.1:6379` (or the managed URL) to
the systemd unit's `Environment=` lines on **every** instance and reload the
service. When `REDIS_URL` is unset the server runs in single-instance mode with
in-memory state — keep it unset for a one-VM deployment. Secure self-hosted Redis
by binding to localhost (or a private subnet) and/or setting `requirepass`; never
expose it publicly.

---

## 7. Sudoers — passwordless restart for the deploy script

The CI deploy script runs `sudo systemctl reload-or-restart robot-signal` and `sudo systemctl is-active robot-signal` as the deploy user. Grant passwordless sudo for those two commands only:

```bash
# On the VM
sudo visudo -f /etc/sudoers.d/studious-robot-deploy
```

Add the following line and save (substitute `ubuntu` for `opc` if deploying on Oracle Linux):

```
ubuntu ALL=(ALL) NOPASSWD: /bin/systemctl reload-or-restart robot-signal, /bin/systemctl is-active robot-signal
```

> **Note:** On some distributions (Oracle Linux 8+, Ubuntu 20.04+) `systemctl` lives at `/usr/bin/systemctl`. Verify with `which systemctl` on the VM and use that path in the sudoers rule. Using the wrong path will silently cause the passwordless sudo to fail and prompt for a password instead.

---

## 8. Networking — open port 4173 (or 443) and set up dynamic DNS

### 8a. GCP (reference deployment)

1. In the GCP Console, go to **VPC network → Firewall** and add a rule allowing ingress TCP on `4173` (or `443` once nginx is fronting it) from `0.0.0.0/0`.
2. If the VM doesn't have a static IP, use **DuckDNS** for free dynamic DNS: create a subdomain at [duckdns.org](https://www.duckdns.org), then keep it updated with a cron job or systemd timer that periodically curls DuckDNS's update URL with the VM's current IP.

### 8b. OCI (alternative)

Oracle Cloud blocks traffic at **two independent layers**. You must open the port in **both**.

**OCI Security List / Network Security Group:**

1. In the OCI Console, go to **Networking → Virtual Cloud Networks → your VCN → Security Lists** (or the attached NSG).
2. Add an **Ingress rule**:
   - Source CIDR: `0.0.0.0/0`
   - Protocol: TCP
   - Destination port: `4173` (or `443` if you put a reverse proxy in front — see §9)

**VM host firewall:**

Oracle Linux images ship with **firewalld** enabled; Ubuntu images may use **iptables** with saved rules. You must open the port on the host too.

**Oracle Linux (firewalld):**

```bash
sudo firewall-cmd --permanent --add-port=4173/tcp
sudo firewall-cmd --reload
# Verify
sudo firewall-cmd --list-ports
```

**Ubuntu (iptables-persistent):**

```bash
sudo iptables -I INPUT 6 -p tcp --dport 4173 -j ACCEPT
sudo netfilter-persistent save
```

> If signaling works locally on the VM but not from the phone, a missing firewall rule at one of these layers is almost always the cause.

---

## 9. TLS reverse proxy (required)

Your Android app uses `wss://` for signaling. Serving the raw Node server over `ws://` (plain WebSocket) will be **blocked on Android** unless cleartext traffic is explicitly enabled in the app manifest — and it shouldn't be in production. Put a TLS-terminating reverse proxy in front of the Node server.

### Option A — nginx + certbot (reference GCP + Ubuntu deployment)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

**nginx server block** (e.g. `/etc/nginx/sites-available/robot-signal`, then symlink into `sites-enabled` and `sudo nginx -t && sudo systemctl reload nginx`):

```nginx
server {
    listen 80;
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

> **nginx note:** without the `Upgrade`/`Connection` headers, Socket.IO's WebSocket transport silently falls back to long-polling.

Then obtain and install the certificate — `certbot --nginx` rewrites the server block to listen on 443 with TLS and installs a `certbot.timer` systemd unit that auto-renews the certificate twice daily:

```bash
sudo certbot --nginx -d yourname.duckdns.org
systemctl list-timers | grep certbot   # confirm certbot.timer is scheduled
```

Open port 443 in the GCP firewall (see §8a), and point your `SIGNALING_URL` in the app to `https://yourname.duckdns.org`.

### Option B — Caddy (alternative, e.g. OCI)

```bash
# Oracle Linux
sudo dnf install -y caddy
# Ubuntu
sudo apt-get install -y caddy
```

**Caddyfile** (`/etc/caddy/Caddyfile`):

```caddy
signal.yourdomain.com {
    reverse_proxy 127.0.0.1:4173
}
```

Caddy provisions a Let's Encrypt certificate automatically and handles WebSocket upgrades without any extra configuration.

```bash
sudo systemctl enable --now caddy
```

Open port 443 in both the OCI Security List and the host firewall (see §8b), and point your `SIGNALING_URL` in the app to `https://signal.yourdomain.com`.

---

## 10. Viewing logs

```bash
# Follow live logs
journalctl -u robot-signal -f

# Last 100 lines
journalctl -u robot-signal -n 100 --no-pager
```

---

## 11. Health check

The server exposes `GET /health`. Verify the service is up:

```bash
curl http://localhost:4173/health
```

Expected response: `200 OK` with a JSON body (e.g. `{"status":"ok"}`).

---

## 12. How the automated deploy works

On every push to `master` that touches `server/**` or the workflow file, GitHub Actions runs:

1. **test** job — `npm ci` + `npm test` inside `server/`.
2. **deploy** job (only if `test` passes) — connects to the VM over SSH and runs:

```bash
set -euo pipefail
cd ~/repos/studious-robot
git fetch --quiet origin master
git reset --hard origin/master
# Install prod deps + restart the service (pulls changes, then restarts).
bash deploy/deploy.sh
```

`deploy/deploy.sh` is the single source of truth for the deploy cycle and can
also be run manually over SSH on the VM. It pulls the target branch, installs
production dependencies, restarts the service **after** pulling the changes, and
verifies the service came back up:

```bash
# Manual redeploy on the VM (uses the same script CI runs):
bash ~/repos/studious-robot/deploy/deploy.sh
# Optional overrides: REPO_DIR, DEPLOY_BRANCH, SERVICE_NAME
```

The job **fails** (and you get a GitHub notification) if the service does not become active within 2 seconds of the reload-or-restart.

---

## 13. Message store (MongoDB / Cosmos DB) — provider notes

Chat message history and conversation lists are persisted via `server/src/messageStore.ts` when `MONGODB_URI` is set (Postgres/Neon remains the store for users/devices/calls/events; this is a separate, optional store). Two Azure-hosted Mongo-compatible providers are supported and behave differently:

| Concern | DocumentDB (vCore) | Cosmos DB for MongoDB (RU) |
|---|---|---|
| Connection string | standard `mongodb://…` / `mongodb+srv://…` | requires `retrywrites=false` in the connection string |
| Unique indexes | any field | must include the shard key (`conversationId`) |
| Sorted queries | falls back to a collection scan | require a matching, direction-specific composite index — otherwise HTTP 400 `BadRequest` |
| Throughput | per-cluster | RU/s cap; heavy load returns `429` (throttled) |

The store's startup index creation, `saveMessage` upsert, and `listConversations` query shape are all written to satisfy the stricter Cosmos RU column, while remaining correct and unchanged on vCore, real MongoDB, and the in-memory store — see the comments in `server/src/messageStore.ts` for the details. At startup the server logs the active Mongo host, database, collection, and whether `retryWrites` is disabled, so you can confirm which backend is live from `journalctl` without inspecting the connection string (credentials are never logged).

> **Switching `MONGODB_URI` between providers does not migrate data.** The target starts empty — there is no automatic copy of existing message history between DocumentDB, Cosmos DB, or a from-scratch MongoDB instance.
