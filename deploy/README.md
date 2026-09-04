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

### PM2 multi-process path (keeps systemd single-instance path intact)

For one VM running multiple signaling processes, this repo now ships
`deploy/ecosystem.config.js`:

- `instances: 6` by default on 8 vCPU (override with `PM2_INSTANCES`)
- `exec_mode: "fork"` with `increment_var: "PORT"`
- `kill_timeout: 30000` (must be >= `SHUTDOWN_DRAIN_MS`)

Example nginx upstream (round-robin; **no `ip_hash`**):

```nginx
upstream robot_signal {
    server 127.0.0.1:4173;
    server 127.0.0.1:4174;
    server 127.0.0.1:4175;
    server 127.0.0.1:4176;
    server 127.0.0.1:4177;
    server 127.0.0.1:4178;
}
```

`deploy/deploy.sh` supports both runtimes:

- `DEPLOY_RUNTIME=systemd` (default, existing path)
- `DEPLOY_RUNTIME=pm2` (uses `pm2 reload ... --update-env`)

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

### Redis (horizontal scaling) configuration

Redis is required for **N > 1 signaling instances** (multiple processes/VMs
behind a load balancer). It provides:

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
service. For multi-instance, use round-robin upstream routing (remove `ip_hash`)
after verifying `/health` reports `stateAffinity: "shared"`.
Secure self-hosted Redis by binding to localhost (or a private subnet) and/or
setting `requirepass`; never expose it publicly.

**Startup guard.** Running more than one instance without `REDIS_URL` is a
silent correctness bug: each process keeps its own sessions, presence, call
registry and read cache, so a cache invalidation published by one process never
reaches the other five and clients can read stale data for a full TTL. To make
that impossible to miss, a process whose PM2 ordinal (`NODE_APP_INSTANCE`, or
`pm_id`) is greater than zero refuses to start when `REDIS_URL` is unset and
`NODE_ENV=production`, and logs a warning otherwise (see
`server/src/lib/instances.ts`). Instance `0` is never faulted — it cannot tell
whether it is alone — so a single-instance host is unaffected.

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

The `messages` collection is partitioned by `conversationId`. The legacy
`listConversations` filter is
`{$or:[{senderId:userId},{recipientId:userId}]}` with no projection, sort, or
limit; it therefore fans out to every conversation partition and downloads all
matching message documents before grouping in the server. The 300–400 ms
timings with a stable 13 ms RTT are consistent with that server-side RU/query
cost, not network variance. No composite index can efficiently satisfy that
participant filter plus a sort on the latest message computed by grouping.

The optimized path uses a separate `conversation_index` collection partitioned
by `userId`. Each row contains the latest message and unread count, so the
conversation list is one projected, single-partition query for at most 100
recently active conversations. Message writes and mutations maintain both
users' summary rows. The old fan-out remains the default until the index is
completely backfilled, preserving existing data.

Provision and activate it in this order:

```bash
# Replace placeholders; omit --throughput when the database uses shared throughput.
az cosmosdb mongodb collection create \
  --account-name <account> \
  --resource-group <resource-group> \
  --database-name wetalk \
  --name conversation_index \
  --shard userId

# Add MONGODB_CONVERSATION_INDEX_WRITES=true to /etc/robot-signal/env and
# gracefully reload PM2. Reads still use the legacy path during this phase,
# while every new message updates both stores.
#
# Before the command below, gracefully drain and stop every signaling-server
# process that can write messages. Keep them stopped until the backfill and
# index verification finish: the backfill is authoritative and must not race
# a newer dual-write.

cd /home/wetalk/repos/studious-robot/server
set -a
. /etc/robot-signal/env
set +a
npm run db:backfill-conversations

# Verify both indexes before enabling reads.
mongosh "$MONGODB_URI" --quiet --eval \
  'db.getSiblingDB("wetalk").conversation_index.getIndexes()'
```

Then add `MONGODB_CONVERSATION_INDEX_READY=true` to
`/etc/robot-signal/env` and restart the stopped PM2 processes. Do not set the
read flag or restart any writer before the backfill completes. Keep
`MONGODB_CONVERSATION_INDEX_WRITES=true`; the read flag also implies writes as
a fail-safe. Use
`MONGODB_CONVERSATION_INDEX_COLLECTION` if the provisioned name differs.

The store also creates the exact supporting indexes:

- `messages: {conversationId:1, createdAt:-1, messageId:-1}` for latest-message reads;
- `conversation_index: {userId:1, updatedAt:-1, conversationId:1}` for the bounded list;
- unique `conversation_index: {userId:1, conversationId:1}` for idempotent writes.

#### Message search (`bodyLower`)

`searchMessages` used to run a case-insensitive regex (`$options: 'i'`) over
`body` across every partition in the collection: no index can serve such a
regex, and without the shard key in the filter Cosmos fans the query out
account-wide. Two changes fix that, both rolled out the same way as the
conversation index:

- Once the conversation index is in service (`MONGODB_CONVERSATION_INDEX_READY`)
  the search filter is scoped with `conversationId: {$in: [...]}`, so it reads
  only the caller's own partitions. No extra configuration and no backfill.
- `bodyLower`, a storage-only case-folded copy of `body`, lets the read path
  drop `$options: 'i'` and use the `{conversationId:1, bodyLower:1}` index. It
  needs a backfill, so it is behind its own two flags.

```bash
# Phase 1 — dual-write. Add MONGODB_MESSAGE_BODY_LOWER_WRITES=true to
# /etc/robot-signal/env and gracefully reload PM2. Reads are unchanged; every
# new or deleted message now maintains bodyLower.

# Phase 2 — backfill. Safe to run with writers up (each update is idempotent
# and only touches documents whose bodyLower is missing or stale), and safe to
# re-run. It also creates the {conversationId:1, bodyLower:1} index.
cd /home/wetalk/repos/studious-robot/server
set -a
. /etc/robot-signal/env
set +a
npm run db:backfill-body-lower

# Phase 3 — read. Add MONGODB_MESSAGE_BODY_LOWER_READY=true and reload.
```

Keep `MONGODB_MESSAGE_BODY_LOWER_WRITES=true` afterwards; as with the
conversation index the read flag implies writes as a fail-safe. To roll back,
clear the read flag — the `body` regex path is still correct at any time.

Mongo command monitoring logs Cosmos `429` / Mongo `16500` responses as
`[messages] THROTTLED` with command name and retry delay only; filters,
documents, and credentials are never logged. The Mongo pool is reused and
bounded to four connections per process by default.

Postgres investigation found that `users.user_id` is the primary key and
`users.auth_uid` is unique, while device/call/event lookup indexes already
exist. The observed startup `users` select is a full hydration read, not an
unindexed lookup. Device, call, and event writes are independent real-time
durability events and cannot be safely batched without changing acknowledgement
semantics. The singleton `pg` pool was already reused, but its default 10-second
idle expiry caused sporadic operations to pay connection/TLS setup again; idle
connections are now retained for five minutes with TCP keepalive. Override with
`DATABASE_POOL_IDLE_TIMEOUT_MS` if the provider requires a shorter lifetime.

At startup the server logs the active Mongo host, database, collection, and whether `retryWrites` is disabled, so you can confirm which backend is live from `journalctl` without inspecting the connection string (credentials are never logged).

> **Switching `MONGODB_URI` between providers does not migrate data.** The target starts empty — there is no automatic copy of existing message history between DocumentDB, Cosmos DB, or a from-scratch MongoDB instance.

---

## 14. Wetalk production PM2 snapshot (authoritative for host migration)

Current production (`signal.kiyon.store`) runs as user `wetalk` from
`/home/wetalk/repos/studious-robot`, supervised by `pm2-wetalk.service`.

### Files now tracked in-repo

- `deploy/start.sh` → wrapper that sources `/etc/robot-signal/env` but preserves
  PM2-injected `PORT` (`increment_var` safety).
- `deploy/ecosystem.config.js` → multi-instance PM2 profile (ports 4173–4178).
- `deploy/nginx/robot-signal-upstream.conf` → upstream with
  `max_fails=2 fail_timeout=10s` per backend.
- `deploy/wetalk-deploy` → host deploy script snapshot (PM2 reload path, per-port
  readiness checks, failure log dump, service-user re-exec guard).

For a single-instance host, keep the systemd path (`deploy/robot-signal.service`)
as fallback recovery, and set PM2 `instances: 1` (drop `increment_var`).

### `deploy/wetalk-deploy` behaviour and overrides

The script self-elevates to the `wetalk` service user, resets the checkout to
`origin/$DEPLOY_BRANCH`, installs production dependencies **only when they
changed**, runs a non-fatal schema check, reloads PM2, and health-checks every
port in `PORTS` until `/health` reports `"status":"ok"` (and not
`"status":"starting"`).

Every variable below can be overridden on the command line; they are forwarded
explicitly across the `sudo -u wetalk` re-exec (the environment stays explicit —
`sudo -E` is deliberately not used):

| Variable | Default |
| --- | --- |
| `REPO_DIR` | `/home/wetalk/repos/studious-robot` |
| `DEPLOY_BRANCH` | `master` |
| `SERVICE_NAME` | `robot-signal` |
| `PM2_ECOSYSTEM` | `$REPO_DIR/deploy/ecosystem.config.js` |
| `SERVER_DIR` | `$REPO_DIR/server` |
| `PORTS` | `4173 4174 4175 4176 4177 4178` |
| `HEALTH_PATH` | `/health` |
| `MAX_ATTEMPTS` | `60` |
| `SLEEP_SECONDS` | `2` |

`deploy/ecosystem.config.js` declares `instances: 6` with
`increment_var: 'PORT'`, but a host actually running a **single** instance only
listens on 4173. Deploy such a host with the matching override, otherwise the
health check waits `MAX_ATTEMPTS × SLEEP_SECONDS` on each port that nothing is
listening on:

```bash
sudo PORTS=4173 wetalk-deploy
```

**Dependency install.** The blob SHA of `server/package-lock.json` is captured
before `git reset --hard` and compared afterwards. `npm ci --omit=dev --no-audit
--no-fund` runs only when the lockfile changed or `node_modules` is absent;
otherwise the script logs `[deploy] lockfile unchanged; skipping install`.
`npm install` is never used — `npm ci` guarantees production runs exactly the
tree CI tested and cannot mutate the lockfile on the VM.

**Schema check.** The check runs from `$SERVER_DIR` with `/etc/robot-signal/env`
sourced in a subshell (its contents are never logged). When the check cannot run
— `drizzle-kit` absent (the normal production case, since `npm ci --omit=dev`
skips dev dependencies), no database URL, or an unreadable env file — it logs a
"skipped" line rather than warning. Only an actual failing check warns about
possible drift/pending migrations. It is never fatal, and the deploy script
never runs migrations — those are applied from CI
(`.github/workflows/backend-ci.yml`) against `DATABASE_URL_DIRECT`.

**Reload semantics.** The script performs a rolling `pm2 reload`. That is *not*
sufficient for the conversation-index backfill in §13, which requires every
writer process to be fully **stopped** for the duration of the backfill.

### Production env file shape (no secrets committed)

`/etc/robot-signal/env` is loaded server-side (mode `640 root:wetalk`). Keep real
values only on host:

```dotenv
DATABASE_URL=<DATABASE_URL>
REDIS_URL=<REDIS_URL>
TURN_STATIC_AUTH_SECRET=<TURN_STATIC_AUTH_SECRET>
AZURE_NOTIFICATION_HUB_CONNECTION_STRING=<AZURE_NOTIFICATION_HUB_CONNECTION_STRING>
DATABASE_POOL_MAX=4
PORT=4173
HOST=127.0.0.1
```

### Nginx topology notes

- Multi-instance host: include `deploy/nginx/robot-signal-upstream.conf` under
  `/etc/nginx/conf.d/` and use `proxy_pass http://robot_signal;`.
- Do **not** use `ip_hash` (state affinity is `shared` via Redis + Socket.IO
  Redis adapter).
- Single-instance host: skip upstream file and proxy directly to
  `http://127.0.0.1:4173`.

### Incident traps to avoid

1. **`PORT` in env file can clobber PM2 `increment_var`.** If sourced directly,
   all instances bind 4173 and crash-loop with `EADDRINUSE`. `deploy/start.sh`
   preserves PM2's runtime `PORT`.
2. **`sudo -u wetalk` from unreadable cwd causes misleading `EACCES`.** Always
   `cd /tmp` before PM2/Node commands; inaccessible cwd can surface as
   `spawn /usr/bin/node EACCES`.
3. **`pm2 startup` can bake the wrong user PATH into systemd.** Avoid
   `sudo env PATH=$PATH pm2 startup`; verify only `pm2-wetalk.service` exists:
   `systemctl list-unit-files | grep pm2`.
4. **Scale database pool with instance count.** Example: `DATABASE_POOL_MAX=4`
   for six instances (~24 total). Restore to `20` for a single-instance host.
5. **Orphan after reload can hold the port.** Compare
   `ss -lntp | grep 4173` vs `ps -u wetalk -o pid,ppid,etime,args`; PPID `1` with
   longer `etime` indicates orphan. Drain first (`kill <pid>`), then
   `pm2 restart robot-signal` and `pm2 reset robot-signal`.

### Additional operational notes

- Do **not** `apt-get install npm`; NodeSource `nodejs` already includes npm.
  Install PM2 with `sudo npm install -g pm2`.
- Disable legacy supervisor before PM2: `sudo systemctl disable --now robot-signal.service`.
- `wetalk` has no password; `su - wetalk` fails by design. Use
  `sudo -u wetalk -H env PATH=... <cmd>`.
- PM2 daemons are per-user. `pm2 ls` as `ubuntu` can be empty while `wetalk`
  has active processes.
- After reaching a known-good state, run `pm2 save` so `pm2 resurrect` restores
  the current process list.

### Verification commands

Per-port health:

```bash
for p in 4173 4174 4175 4176 4177 4178; do
  curl -fsS "http://127.0.0.1:${p}/health"
done
```

Load-distribution check (parallel requests):

```bash
seq 30 | xargs -P 10 -I{} curl -s https://signal.kiyon.store/health \
  | grep -o '"instanceId":"[^"]*"' | sort | uniq -c
```

Sequential curls are misleading because each nginx worker keeps its own
round-robin cursor.

### Region selection rule of thumb

Database locality dominates end-to-end latency. In prior measurement runs from
Paris, `mtr` to Cloud SQL/Cosmos was far higher than local hops, and write
latency reflected that penalty. Before choosing a new region, run `mtr` from
candidate hosts to each database endpoint and prioritize co-location with data.
