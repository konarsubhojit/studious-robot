# studious-robot — OCI VM Deployment Guide

This document covers the **one-time VM setup** and explains how the automated SSH deploy works.

---

## Architecture overview

```
GitHub Actions (push to master)
  └─► appleboy/ssh-action → OCI Ampere A1 VM
          ├─ git fetch / reset
          ├─ npm ci --omit=dev
          └─ sudo systemctl reload-or-restart robot-signal
```

The `studious-robot` Node.js signaling server runs as a **systemd service** on the VM, managed by the unit file at `deploy/robot-signal.service`.

---

## 1. Prerequisites

- Oracle Cloud Infrastructure (OCI) Ampere A1 (arm64) VM running Oracle Linux or Ubuntu.
- A domain name pointing at the VM's public IP (required for TLS; see §7).

---

## 2. Install Node 24

This repository pins **Node 24** via `.nvmrc`. Install it system-wide so `systemd` can find it at `/usr/bin/node`.

### Oracle Linux (dnf)

```bash
# Enable the NodeSource repo for Node 24
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs
node --version   # should print v24.x.x
```

### Ubuntu

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

If `node` ends up at a path other than `/usr/bin/node`, update `ExecStart` in `deploy/robot-signal.service` accordingly (e.g. `/usr/local/bin/node`).

---

## 3. Clone the repository

```bash
sudo git clone https://github.com/konarsubhojit/studious-robot.git /opt/studious-robot
sudo chown -R opc:opc /opt/studious-robot
```

> **Default deploy path:** `/opt/studious-robot`  
> **Service user:** `opc` (Oracle Linux default; adjust in the unit file if your user differs)

---

## 4. Install production dependencies

```bash
cd /opt/studious-robot/server
npm ci --omit=dev
```

---

## 5. Install the systemd unit

```bash
sudo cp /opt/studious-robot/deploy/robot-signal.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now robot-signal
sudo systemctl status robot-signal
```

The service listens on `PORT=4173` by default. Edit the unit file's `Environment=` lines to change the port, `CORS_ORIGIN`, etc., then reload:

```bash
sudo systemctl daemon-reload && sudo systemctl restart robot-signal
```

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

The CI workflow SSHes into the VM as user `opc` to run the deploy script. Create a **dedicated deploy key** (do not reuse your personal key).

```bash
# On your local machine (or the VM — keep the private key off the VM)
ssh-keygen -t ed25519 -C "studious-robot-deploy" -f ~/.ssh/studious_robot_deploy
```

**Add the public key to the VM:**

```bash
# On the VM, as opc
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
| `DEPLOY_SSH_USER`   | `opc` (or your VM user)                         |
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

- a **Pub/Sub message bus** for cross-instance call-state events, and
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

The CI deploy script runs `sudo systemctl reload-or-restart robot-signal` and `sudo systemctl is-active robot-signal` as the `opc` user. Grant passwordless sudo for those two commands only:

```bash
# On the VM
sudo visudo -f /etc/sudoers.d/studious-robot-deploy
```

Add the following line and save:

```
opc ALL=(ALL) NOPASSWD: /bin/systemctl reload-or-restart robot-signal, /bin/systemctl is-active robot-signal
```

> **Note:** On some distributions (Oracle Linux 8+, Ubuntu 20.04+) `systemctl` lives at `/usr/bin/systemctl`. Verify with `which systemctl` on the VM and use that path in the sudoers rule. Using the wrong path will silently cause the passwordless sudo to fail and prompt for a password instead.

---

## 8. OCI networking — open port 4173 (or 443)

Oracle Cloud blocks traffic at **two independent layers**. You must open the port in **both**.

### 8a. OCI Security List / Network Security Group

1. In the OCI Console, go to **Networking → Virtual Cloud Networks → your VCN → Security Lists** (or the attached NSG).
2. Add an **Ingress rule**:
   - Source CIDR: `0.0.0.0/0`
   - Protocol: TCP
   - Destination port: `4173` (or `443` if you put a reverse proxy in front — see §9)

### 8b. VM host firewall

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

> If signaling works locally on the VM but not from the phone, a missing firewall rule at one of these two layers is almost always the cause.

---

## 9. TLS reverse proxy (recommended)

Your Android app uses `wss://` for signaling. Serving the raw Node server over `ws://` (plain WebSocket) will be **blocked on Android** unless cleartext traffic is explicitly enabled in the app manifest — and it shouldn't be in production. Put a TLS-terminating reverse proxy in front of the Node server.

### Option A — Caddy (easiest, auto-certificates)

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

Open port 443 in both the OCI Security List and the host firewall (see §8), and point your `SIGNALING_URL` in the app to `https://signal.yourdomain.com`.

### Option B — nginx

```nginx
server {
    listen 443 ssl;
    server_name signal.yourdomain.com;

    # ... ssl_certificate / ssl_certificate_key (use certbot) ...

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

> **nginx note:** without the `Upgrade`/`Connection` headers, Socket.IO's WebSocket transport silently falls back to long-polling. Caddy handles this automatically; nginx requires these headers explicitly.

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
cd /opt/studious-robot
git fetch --quiet origin master
git reset --hard origin/master
cd server
npm ci --omit=dev
sudo systemctl reload-or-restart robot-signal
sleep 2
sudo systemctl is-active --quiet robot-signal && echo "robot-signal is running"
```

The job **fails** (and you get a GitHub notification) if the service does not become active within 2 seconds of the reload-or-restart.
