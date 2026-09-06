# studious-robot — VM Deployment Guide

This document covers the **one-time VM setup** and explains how the automated SSH deploy works.

The **deployment target** is **Oracle Cloud Infrastructure (OCI)** running **Oracle Linux**, with the service user `opc`, **firewalld**, and **Caddy** terminating TLS. The fleet is **two small signaling VMs behind a load balancer, plus a separate host running Postgres and Redis**. Each signaling VM runs **one plain systemd unit** — there is no process manager in front of it. A **GCP e2-micro / Ubuntu** host (user `ubuntu`, nginx + certbot) is also documented as an alternative; sections below call out where the two paths differ.

> **PM2 is no longer used.** Everything below assumes systemd. Because the fleet has more than one instance, **`REDIS_URL` is mandatory** — see §5a.

---

## Architecture overview

```
GitHub Actions (push to master)
  └─► appleboy/ssh-action → each signaling VM (OCI / Oracle Linux)
          ├─ git fetch / reset
          ├─ npm ci --omit=dev
          └─ sudo systemctl reload-or-restart robot-signal

                     load balancer (round-robin, no ip_hash)
                       │
      ┌────────────────┴────────────────┐
   signal VM 0                       signal VM 1
   robot-signal.service              robot-signal.service
   INSTANCE_ID=0                     INSTANCE_ID=1
      └────────────────┬────────────────┘
                       │
            data host: Postgres + Redis
```

The `studious-robot` Node.js signaling server runs as a **systemd service** on each VM, managed by the unit file at `deploy/robot-signal.service`, and is fronted by a TLS-terminating reverse proxy (Caddy on OCI, nginx + certbot on the Ubuntu alternative). **Every step below is performed on each signaling VM**, with the per-VM differences (`INSTANCE_ID`, `PORT`) called out where they occur.

---

## 1. Prerequisites

- Two VMs running Oracle Linux (target: **OCI**, arm64) or Ubuntu (alternative: GCP e2-micro), plus a host reachable from both running **Postgres** and **Redis**.
- A load balancer (or reverse proxy) in front of the two signaling VMs.
- A domain name (or a free **DuckDNS** subdomain) pointing at the VM's public IP (required for TLS; see §9).

---

## 2. Install Node 24

This repository pins **Node 24** via `.nvmrc`. Install it system-wide so `systemd` can find it at `/usr/bin/node`.

### Oracle Linux (dnf) — deployment target

```bash
# Enable the NodeSource repo for Node 24
curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash -
sudo dnf install -y nodejs
node --version   # should print v24.x.x
```

### Ubuntu (alternative)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

If `node` ends up at a path other than `/usr/bin/node`, update `ExecStart` in `deploy/robot-signal.service` accordingly (e.g. `/usr/local/bin/node`).

---

## 3. Clone the repository

```bash
mkdir -p ~/repos
git clone https://github.com/konarsubhojit/studious-robot.git ~/repos/studious-robot
```

> **Repo path:** `~/repos/studious-robot`  
> **Service user:** `opc` (Oracle Linux default, what the shipped unit expects) or `ubuntu` (Ubuntu default) — set `User=`/`Group=` in the unit file to match, and see §5's note on `WorkingDirectory=`.

---

## 4. Install production dependencies

```bash
cd ~/repos/studious-robot/server
npm ci --omit=dev
```

---

## 5. Install the systemd unit

The shipped `deploy/robot-signal.service` defaults to `User=opc` and `WorkingDirectory=/home/opc/repos/studious-robot/server` (the Oracle Linux layout). **Before installing it**, edit both if your VM's user or repo path differs (e.g. `User=ubuntu` and `WorkingDirectory=/home/ubuntu/repos/studious-robot/server` on Ubuntu):

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

#### Secure the env file

`/etc/robot-signal/env` holds every database credential, the TURN secret and
the push keys. systemd reads it **as root, before dropping to `User=`**, so the
service user never needs read access — and must not have it:

```bash
sudo install -d -m 0700 -o root -g root /etc/robot-signal
sudo install -m 0600 -o root -g root /dev/null /etc/robot-signal/env
sudo ${EDITOR:-vi} /etc/robot-signal/env
# Verify — this must print 600 root root:
stat -c '%a %U %G' /etc/robot-signal/env
```

Anything looser (e.g. `640 root:opc`, or a copy inside the checkout) puts the
credentials within reach of the service user and of anyone who can read the
repo directory.

#### Sandboxing

The unit runs with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`,
`PrivateTmp`, a `@system-service` syscall filter and `MemoryMax=1G`.
Two of those have operational consequences worth knowing before you debug a
start failure:

- **`ProtectSystem=strict` makes the whole filesystem read-only**, including the
  checkout. The server never writes to disk — logs go to the journal — so this
  costs nothing today. If you add something that writes a file, add a
  `ReadWritePaths=` entry for that one directory rather than weakening the
  setting.
- **`ProtectHome=read-only`, not `true`**, because `WorkingDirectory=` is under
  `/home/opc`. `ProtectHome=true` replaces `/home` with an empty tmpfs and the
  unit fails to start. Moving the checkout to `/srv/robot-signal` lets you use
  the stronger value.

Check the sandbox after any unit edit:

```bash
systemd-analyze security robot-signal
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

## 5a. Two instances — and the shared state they oblige

The fleet is **two signaling VMs**, each running one `robot-signal.service`,
behind a round-robin load balancer. A client's requests — and its WebSocket —
can land on either VM, and may move between them on any reconnect. That single
fact drives everything in this section.

### `REDIS_URL` is mandatory here

Almost all cross-request state in this server is only shared between instances
when `REDIS_URL` is configured:

- the **call registry**, so a call created on VM 0 can be accepted on VM 1;
- **sessions and presence**, so a reconnect to the other VM is not a silent
  logout;
- the **read cache** (conversation lists, first-page history, call history) and
  the **Pub/Sub bus** that invalidates it, so an invalidation on one VM is not
  invisible to the other for a full TTL;
- the **Socket.IO Redis adapter**, so an event addressed to a user reaches
  their socket whichever VM holds it.

Without it each VM keeps a private copy of all four and the deployment is
quietly wrong rather than loudly broken — clients read stale data, calls
disappear, and nothing logs an error. Set `REDIS_URL` in
`/etc/robot-signal/env` on **both** VMs, pointing at the shared data host.

### Give each VM a distinct `INSTANCE_ID`

The server refuses to start without `REDIS_URL` when it knows it is one of
several — but with separate VMs nothing tells it that automatically. Declare it
per host in `/etc/robot-signal/env`:

```dotenv
# VM 0
INSTANCE_ID=0
# VM 1
INSTANCE_ID=1
```

A process with `INSTANCE_ID` greater than zero and no `REDIS_URL` throws at
startup under `NODE_ENV=production`, and warns otherwise (see
`server/src/lib/instances.ts`). Instance `0` is never faulted — it cannot tell
whether it is alone — so **`INSTANCE_ID` on the second VM is what arms the
guard**. Set it before you need it.

The same variable is what a systemd *template* unit would supply if you ever
consolidate onto one larger host: copy `robot-signal.service` to
`/etc/systemd/system/robot-signal@.service` and map the instance name onto both
the ordinal and the port —

```ini
# In [Service], replacing the fixed Environment=PORT= line:
Environment=INSTANCE_ID=%i
Environment=PORT=417%i
```

```bash
sudo systemctl enable --now robot-signal@0 robot-signal@1
```

### Load balancing

Use **round-robin — not `ip_hash`**. With Redis the state affinity is `shared`,
so sticky routing buys nothing and costs you an uneven distribution. Confirm
before switching:

```bash
curl -fsS https://signal.yourdomain.com/health | grep -o '"stateAffinity":"[^"]*"'
# must print "stateAffinity":"shared" on BOTH VMs
```

nginx, with both VMs' private addresses:

```nginx
upstream robot_signal {
    server 10.0.0.11:4173 max_fails=2 fail_timeout=10s;
    server 10.0.0.12:4173 max_fails=2 fail_timeout=10s;
}
```

Socket.IO needs the `Upgrade`/`Connection` headers on the `proxy_pass` (§9),
otherwise the WebSocket transport silently degrades to long-polling.

### Sizing that follows from N = 2

- **`DB_POOL_SIZE` is per instance.** Two VMs at the default of 4 open 8
  Postgres connections in total; keep the sum inside the data host's limit.
- **Restart one VM at a time**, waiting for its `/health` to return `200`
  before touching the other, so the drain is a rolling one.
- **Redis is a single point of failure for the fleet.** It holds live call
  state and sessions; losing it costs in-flight calls, not durable data
  (Postgres holds that). Bind it to the private subnet, set `requirepass`, and
  never expose it publicly.

---

## 6. Create the deploy SSH key pair

The CI workflow SSHes into the VM as your chosen deploy user (`opc` on Oracle Linux, `ubuntu` on Ubuntu) to run the deploy script. Create a **dedicated deploy key** (do not reuse your personal key).

```bash
# On your local machine (or the VM — keep the private key off the VM)
ssh-keygen -t ed25519 -C "studious-robot-deploy" -f ~/.ssh/studious_robot_deploy
```

**Add the public key to the VM:**

```bash
# On the VM, as the deploy user (opc / ubuntu)
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
| `DEPLOY_SSH_USER`   | `opc` (Oracle Linux) or `ubuntu` (Ubuntu)       |
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

**Required by this deployment** — the fleet is two signaling VMs (§5a).

Redis is required for **N > 1 signaling instances** (multiple processes/VMs
behind a load balancer). It provides:

- a **Pub/Sub message bus** for cross-instance call-state events and cache
  invalidations,
- a **shared read cache** for conversation lists, first-page chat history and
  call history (see `server/src/cache.ts`), and
- the **Socket.IO Redis adapter** so a user's WebSocket events are delivered
  regardless of which instance holds their socket.

Provision Redis and point the server at it with the `REDIS_URL` env var:

- **On the shared data host** (what this deployment does — the same box as
  Postgres, reachable from both signaling VMs over the private subnet):

  ```bash
  # Oracle Linux, on the data host
  sudo dnf install -y redis
  sudo systemctl enable --now redis
  # Bind to the PRIVATE address, never 0.0.0.0, and set requirepass:
  #   bind 10.0.0.10
  #   requirepass <long-random-secret>
  # Then, on each signaling VM:
  #   REDIS_URL=redis://:<secret>@10.0.0.10:6379
  ```

  Open 6379 to the signaling VMs' subnet only — in both the OCI Security List
  and the data host's firewalld (§8b covers the same two-layer rule for 4173).

- **Managed** (OCI Cache / Redis Cloud / Upstash): create an instance and use the
  provider's `rediss://…` URL (TLS).

Then add `REDIS_URL=…` to `/etc/robot-signal/env` on **both** signaling VMs
and reload the service. Use round-robin upstream routing (no `ip_hash`) after
verifying `/health` reports `stateAffinity: "shared"` on each.
Secure self-hosted Redis by binding to localhost (or a private subnet) and/or
setting `requirepass`; never expose it publicly.

**Startup guard.** Running more than one instance without `REDIS_URL` is a
silent correctness bug: each process keeps its own sessions, presence, call
registry and read cache, so a cache invalidation published by one process never
reaches the others and clients can read stale data for a full TTL. To make that
impossible to miss, a process whose declared ordinal (`INSTANCE_ID`, or
`SIGNAL_INSTANCE_ID`) is greater than zero refuses to start when `REDIS_URL` is
unset and `NODE_ENV=production`, and logs a warning otherwise (see
`server/src/lib/instances.ts`). Instance `0` is never faulted — it cannot tell
whether it is alone — so **the guard only arms once you set `INSTANCE_ID=1` on
the second VM** (§5a). Set it as part of provisioning, not after an incident.

---

## 7. Sudoers — passwordless restart for the deploy script

The CI deploy script runs `sudo systemctl reload-or-restart robot-signal` and `sudo systemctl is-active robot-signal` as the deploy user. Grant passwordless sudo for those two commands only:

```bash
# On the VM
sudo visudo -f /etc/sudoers.d/studious-robot-deploy
```

Add the following line and save (substitute `ubuntu` for `opc` if deploying on Ubuntu):

```
opc ALL=(ALL) NOPASSWD: /bin/systemctl reload-or-restart robot-signal, /bin/systemctl is-active robot-signal
```

> **Note:** On some distributions (Oracle Linux 8+, Ubuntu 20.04+) `systemctl` lives at `/usr/bin/systemctl`. Verify with `which systemctl` on the VM and use that path in the sudoers rule. Using the wrong path will silently cause the passwordless sudo to fail and prompt for a password instead.

---

## 8. Networking — open port 4173 (or 443) and set up dynamic DNS

### 8a. GCP (alternative)

1. In the GCP Console, go to **VPC network → Firewall** and add a rule allowing ingress TCP on `4173` (or `443` once nginx is fronting it) from `0.0.0.0/0`.
2. If the VM doesn't have a static IP, use **DuckDNS** for free dynamic DNS: create a subdomain at [duckdns.org](https://www.duckdns.org), then keep it updated with a cron job or systemd timer that periodically curls DuckDNS's update URL with the VM's current IP.

### 8b. OCI (deployment target)

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

### Option A — nginx + certbot (GCP + Ubuntu alternative)

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

### Option B — Caddy (OCI deployment target)

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
# restart the service. Reads still use the legacy path during this phase,
# while every new message updates both stores.
#
# Before the command below, stop the signaling service
# (`sudo systemctl stop robot-signal`). Keep them stopped until the backfill and
# index verification finish: the backfill is authoritative and must not race
# a newer dual-write.

cd ~/repos/studious-robot/server
set -a
. /etc/robot-signal/env
set +a
npm run db:backfill-conversations

# Verify both indexes before enabling reads.
mongosh "$MONGODB_URI" --quiet --eval \
  'db.getSiblingDB("wetalk").conversation_index.getIndexes()'
```

Then add `MONGODB_CONVERSATION_INDEX_READY=true` to
`/etc/robot-signal/env` and start the service again. Do not set the
read flag or start any writer before the backfill completes. Keep
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
# /etc/robot-signal/env and restart the service. Reads are unchanged; every
# new or deleted message now maintains bodyLower.

# Phase 2 — backfill. Safe to run with writers up (each update is idempotent
# and only touches documents whose bodyLower is missing or stale), and safe to
# re-run. It also creates the {conversationId:1, bodyLower:1} index.
cd ~/repos/studious-robot/server
set -a
. /etc/robot-signal/env
set +a
npm run db:backfill-body-lower

# Phase 3 — read. Add MONGODB_MESSAGE_BODY_LOWER_READY=true and restart.
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

## 14. Production host snapshot (authoritative for host migration)

Production (`signal.kiyon.store`) runs one `robot-signal.service` unit per
signaling VM from `~/repos/studious-robot`, with no process manager. There are
two such VMs behind a load balancer, plus a separate host running Postgres and
Redis (§5a).

### Files tracked in-repo

- `deploy/robot-signal.service` → the unit (hardened; see §5).
- `deploy/deploy.sh` → the deploy cycle CI runs over SSH (§12).

> **Historical note.** Earlier revisions of this guide described a six-process
> PM2 fleet on ports 4173–4178 with an nginx upstream. That topology, and the
> files that supported it (`ecosystem.config.js`, `start.sh`, `wetalk-deploy`,
> `nginx/robot-signal-upstream.conf`), have been removed. §5a is the supported
> path to more than one process.

### Production env file shape (no secrets committed)

`/etc/robot-signal/env` is loaded by systemd as root before privileges are
dropped (mode `600 root:root` — see §5). Keep real values only on the host:

```dotenv
DATABASE_URL=<DATABASE_URL>
REDIS_URL=<REDIS_URL>
TURN_STATIC_AUTH_SECRET=<TURN_STATIC_AUTH_SECRET>
AZURE_NOTIFICATION_HUB_CONNECTION_STRING=<AZURE_NOTIFICATION_HUB_CONNECTION_STRING>
DEBUG_API_TOKEN=<DEBUG_API_TOKEN>
# Distinct per VM — this is what arms the multi-instance guard (§5a).
INSTANCE_ID=0
DB_POOL_SIZE=4
PORT=4173
HOST=127.0.0.1
```

Only `INSTANCE_ID` differs between the two VMs. `DB_POOL_SIZE` is **per
instance**: keep `instances × DB_POOL_SIZE` inside the data host's connection
limit.

### Reverse-proxy topology

The load balancer fans out to both VMs; each VM's local proxy (if any) points
at its own process. See §5a for the nginx upstream. A Caddy front end:

```caddy
signal.yourdomain.com {
    reverse_proxy 10.0.0.11:4173 10.0.0.12:4173
}
```

Caddy load-balances round-robin by default and upgrades WebSockets without
extra configuration. Do **not** add a hash-based policy: state affinity is
`shared`.

### Incident traps to avoid

1. **The env file wins over `Environment=`.** `EnvironmentFile=` is declared
   last in the unit, so a `PORT` in `/etc/robot-signal/env` overrides the unit's
   default. Set each key in one place only.
2. **`ProtectHome=true` breaks the unit.** The checkout lives under `/home`, so
   the unit ships `ProtectHome=read-only`; tightening it without first moving the
   checkout produces a start failure whose journal line ("No such file or
   directory" for `WorkingDirectory=`) does not obviously point at the sandbox.
3. **A failed start after a unit edit is usually the sandbox, not the app.**
   `systemd-analyze verify /etc/systemd/system/robot-signal.service` and
   `journalctl -u robot-signal -n 50` before suspecting the code.
4. **An orphan can hold the port.** Compare `ss -lntp | grep 4173` against
   `systemctl status robot-signal`. A listener whose PID is not in the unit's
   cgroup survived a previous stop: kill it, then `systemctl start robot-signal`.
5. **`sudo` path for `systemctl`.** On Oracle Linux it is `/usr/bin/systemctl`;
   the sudoers rule in §7 must use the path `which systemctl` reports, or the
   deploy silently prompts for a password and times out.
6. **Do not reintroduce a process manager.** Node runs the TypeScript entry
   point directly and systemd already supplies restart, log capture, resource
   limits and the graceful-drain contract.
7. **A missing `INSTANCE_ID` disarms the multi-instance guard.** Both VMs
   reporting instance `null` means neither will refuse to start with `REDIS_URL`
   missing, and the fleet degrades silently (§5a).
8. **Restart one VM at a time.** Both at once drops every in-flight call; the
   point of the drain window is that it overlaps with the other VM still
   serving.

### Additional operational notes

- Do **not** `dnf install npm` / `apt-get install npm`; the NodeSource `nodejs`
  package already includes it.
- `journalctl -u robot-signal -f` is the only log destination; the app writes
  nothing to disk (and cannot, under `ProtectSystem=strict`).
- After changing the unit file: `sudo systemctl daemon-reload`, then
  `sudo systemctl restart robot-signal`.

### Verification commands

```bash
# On each signaling VM:
curl -fsS http://127.0.0.1:4173/health
systemctl is-active robot-signal
systemd-analyze security robot-signal   # sandbox exposure score
```

`/health` must report `"stateAffinity":"shared"` on **both** VMs. `"sticky"`
means that VM has no `REDIS_URL` and is keeping private state — fix it before
sending it traffic.

Load distribution through the balancer (parallel, not sequential — each proxy
worker keeps its own round-robin cursor):

```bash
seq 30 | xargs -P 10 -I{} curl -s https://signal.yourdomain.com/health \
  | grep -o '"instanceId":"[^"]*"' | sort | uniq -c
```

### Region selection rule of thumb

Database locality dominates end-to-end latency. In prior measurement runs from
Paris, `mtr` to Cloud SQL/Cosmos was far higher than local hops, and write
latency reflected that penalty. Before choosing a new region, run `mtr` from
candidate hosts to each database endpoint and prioritize co-location with data.
