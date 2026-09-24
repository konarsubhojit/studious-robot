# VM redeploy and recovery

This runbook rebuilds, redeploys, and restores the self-hosted signaling fleet.
Run database commands with an explicit connection string and verify the
connection before changing anything.

## Topology

| Host | Services |
| --- | --- |
| `oci` (OCI A1) | PostgreSQL 18, Redis, and a test `robot-signal` bound to `127.0.0.1:4173` |
| `micro2` | `robot-signal` on `127.0.0.1:4173`, behind local nginx |
| `instance-20260903-0936` | `robot-signal` on `127.0.0.1:4173`, behind local nginx |

All three signaling instances use Redis-backed state
(`stateAffinity: "shared"`) and one PostgreSQL database reached over TCP at
`<A1_PRIVATE_IP>:5432`. Each host must have a **unique `INSTANCE_ID`**.
Duplicate IDs silently defeat the multi-instance guard.

The systemd unit loads the service environment from
`/etc/robot-signal/env`. Use placeholders rather than committing private IPs or
credentials:

```dotenv
DATABASE_URL=postgresql://wetalk:<URL_ENCODED_DB_PASSWORD>@<A1_PRIVATE_IP>:5432/wetalk
# Managed Redis (OCI Cache / Valkey) is TLS-only, so the scheme is rediss://.
# A plain redis:// URL never connects to such an endpoint.
REDIS_URL=rediss://<CACHE_USER>:<URL_ENCODED_CACHE_PASSWORD>@<CACHE_PRIVATE_ENDPOINT>:6379
# Self-hosted Redis on the private VCN, without TLS:
# REDIS_URL=redis://<A1_PRIVATE_IP>:6379
INSTANCE_ID=<UNIQUE_INTEGER>
NODE_ENV=production
# Public half of the backup key pair only. The private key must never be
# stored on this VM. See "Encrypted backups".
BACKUP_AGE_RECIPIENT=age1<public-key>
```

On `oci` the backup healthcheck URL is *not* kept in this file; it lives in
`/etc/wetalk-backup/healthcheck.curl` and is read by a `curl --config`
invocation. See "Monitoring (healthchecks.io)".

## Provisioning a fresh VM

Everything below is required on a brand-new Ubuntu 24.04 host before the
"Deploy or redeploy" steps make sense. Each item exists because it was missed
at least once on a real provisioning run.

### The `wetalk` Linux user is not the `wetalk` Postgres role

`wetalk` is *two* things: a Postgres role (created by `CREATE ROLE`) and the
Linux account that owns the checkout and runs `robot-signal`. Creating the
database role does not create the Linux user, and the symptom of that is
`sudo su - wetalk` failing with "user does not exist" or "This account is
currently not available" — which is normal for a system account with
`/usr/sbin/nologin`, not a sign that anything is broken.

```bash
sudo useradd --system --create-home --home-dir /home/wetalk \
  --shell /usr/sbin/nologin wetalk
sudo install -d -o wetalk -g wetalk -m 0755 /home/wetalk/repos
sudo -u wetalk git clone https://github.com/konarsubhojit/studious-robot.git \
  /home/wetalk/repos/studious-robot
# Run a command as the service user without a login shell:
sudo -u wetalk -H bash -lc 'cd /home/wetalk/repos/studious-robot && git status'
```

`deploy/robot-signal.service` in the repo ships `User=opc`, `Group=opc` and
`WorkingDirectory=/home/opc/repos/studious-robot/server` (the Oracle Linux
layout). This fleet runs as `wetalk` out of `/home/wetalk`, so those three
lines **must** be edited before the unit is installed — see
[`deploy/README.md` §5](../deploy/README.md) for the exact edits and for the
file modes `/etc/robot-signal/env` and the FCM key file require.

### Install the OCI CLI system-wide

`wetalk-backup.service` runs as `User=root`, so the CLI must not live in a
user's home directory: a `/home/<user>/bin/oci` path is unreadable under
`ProtectHome=`, and it disappears the day that account is removed. Install it
under `/opt/oci-cli`, which is what `ops/wetalk-backup.sh` defaults to:

```bash
sudo apt-get install -y python3-venv
curl -fsSL https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh \
  -o /tmp/install-oci-cli.sh
sudo bash /tmp/install-oci-cli.sh --accept-all-defaults \
  --install-dir /opt/oci-cli --exec-dir /usr/local/bin
/opt/oci-cli/bin/oci --version
```

The script resolves the binary as `OCI_BIN="${OCI_BIN:-/opt/oci-cli/bin/oci}"`,
so a different install path only needs `Environment=OCI_BIN=/path/to/oci` in
the unit (or the variable in `/etc/robot-signal/env`) rather than a code edit.

### Instance principal setup

Until the instance is a member of a dynamic group that a policy grants bucket
access to, **every** `oci` call from the VM fails `NotAuthenticated` (or the
`BucketNotFound` mask described below). Three things must exist:

1. The instance OCID, read from the instance metadata service:
   ```bash
   curl -fsS -H "Authorization: ******" \
     http://169.254.169.254/opc/v2/instance/id
   ```
2. A dynamic group whose matching rule includes that OCID. Either list the
   instance explicitly or match the whole compartment:
   ```
   instance.id = 'ocid1.instance.oc1..<new-instance>'
   # or, for every instance in the compartment:
   ANY {instance.compartment.id = 'ocid1.compartment.oc1..<compartment>'}
   ```
   A rebuilt VM gets a **new** OCID: the rule must be updated or the new host
   silently has no permissions.
3. A policy in the bucket's compartment granting that dynamic group write
   access:
   ```
   Allow dynamic-group wetalk-backup-hosts to manage objects in compartment <compartment> where target.bucket.name = 'kiyonbucket'
   ```

Verify from the VM before enabling the timer — this must list objects, not
error:

```bash
sudo OCI_CLI_AUTH=instance_principal /opt/oci-cli/bin/oci os object list \
  --auth instance_principal --bucket-name kiyonbucket --prefix pg/ --fields name,size
```

IAM edits take a minute or two to propagate; retest rather than assuming the
rule is wrong.

### Database password prompts and `~/.pgpass`

Stock `pg_hba.conf` on Postgres 18 requires `scram-sha-256` for TCP loopback,
so `psql -h 127.0.0.1` prompts for a password even for a local role. Store it
in a per-user `~/.pgpass` — and note that "per-user" means exactly that: a file
under `/root` does nothing for commands run as `wetalk`, and vice versa.

```bash
sudo install -o root -g root -m 0600 /dev/null /root/.pgpass
printf '%s\n' '127.0.0.1:5432:wetalk:wetalk:<DB_PASSWORD>' | sudo tee /root/.pgpass >/dev/null
sudo chmod 600 /root/.pgpass
# Verify — anything looser than 600 is silently ignored, with no error:
stat -c '%a' /root/.pgpass
```

`libpq` ignores a `.pgpass` whose mode is group- or world-readable and simply
prompts again, which reads as "the password is wrong".

### Both firewall layers

Opening 443 (or 4173) requires an ingress rule in the OCI **Security List / NSG**
*and* a rule in the host firewall — Ubuntu images ship iptables rules that
`REJECT` everything past a point. See
[`deploy/README.md` §8b](../deploy/README.md) for both.

## Deploy or redeploy

Deploy schema changes once, from one host, before restarting the fleet. The
examples assume the checkout is `/home/wetalk/repos/studious-robot` and is
owned by `wetalk`.

### 1. Verify the target database

```bash
sudo bash -c 'set -a; . /etc/robot-signal/env; set +a; echo "[$DATABASE_URL]"; psql "$DATABASE_URL" -c "\conninfo"'
```

The URL must be non-empty and `\conninfo` must show TCP to
`<A1_PRIVATE_IP>` on port `5432`. Do not continue if it shows a local socket.

### 2. Pull, install, build, and migrate

Run on the one host selected to apply migrations:

```bash
sudo -u wetalk -H bash -lc '
  set -euo pipefail
  cd /home/wetalk/repos/studious-robot
  git pull --ff-only
  cd server
  npm i
  npm run typecheck
  set -a
  . /etc/robot-signal/env
  set +a
  echo "[$DATABASE_URL]"
  npm run db:migrate
'
```

`npm run typecheck` is the build verification for this server; production runs
the TypeScript entry point directly.

**Do not use `npm i --omit=dev` on a host that runs migrations.**
`drizzle-kit` is a dev dependency, so `npm run db:migrate` fails or does
nothing when development dependencies were skipped. A full `npm i` is
required.

`server/drizzle.config.ts` prefers `DATABASE_URL_DIRECT`, then falls back to
`DATABASE_URL`. The direct/pooled split exists for Neon's PgBouncer. With
self-hosted PostgreSQL, set both to the same TCP URL or leave
`DATABASE_URL_DIRECT` unset.

The config also imports `dotenv/config`. Remove or inspect a stray
`server/.env` before migrating: it can silently select a different database
than the shell environment and apply migrations to the wrong target.

### 3. Update and restart every instance

On each remaining host, pull and install. A production-only install is safe
there only if that host will not run migrations:

```bash
sudo -u wetalk -H bash -lc '
  set -euo pipefail
  cd /home/wetalk/repos/studious-robot
  git pull --ff-only
  cd server
  npm i --omit=dev
'
sudo systemctl restart robot-signal.service
sudo systemctl status robot-signal.service --no-pager
curl --fail http://127.0.0.1:4173/health
```

Restart `oci` as well after its migration. Confirm every health response
reports shared state — and then prove fan-out really works, per
[Verify fan-out across the fleet](#verify-fan-out-across-the-fleet) — and
inspect logs if a restart fails:

```bash
sudo journalctl -u robot-signal.service -n 100 --no-pager
```

## Migration diagnostics

The host has one PostgreSQL 18 cluster on port 5432 and one `wetalk` database.
Local Unix-socket and TCP connections reach that same database.

### `drizzle-kit migrate` is silent when it has nothing to do

A no-op migration and a successful migration produce identical output: the
configuration banner and nothing else. There is no "up to date" message or
list of applied migrations. Never infer success from this output.

Verify the migration journal and schema explicitly:

```bash
psql "$DATABASE_URL" -c "select id, hash, to_timestamp(created_at/1000)
  from drizzle.__drizzle_migrations order by created_at;"
psql "$DATABASE_URL" -c '\dt'
```

The journal row count must match the number of migration SQL files in
`server/db/migrations/`.

### An unset `DATABASE_URL` fails open, not closed

`psql "$DATABASE_URL"` does not error when the variable is empty. The empty
argument makes psql silently use its defaults: the local Unix socket, peer
authentication, and a database named after the current user. The connection
can succeed and look legitimate even though its provenance is not what the
operator assumed.

Always confirm the variable before drawing conclusions:

```bash
echo "URL=[$DATABASE_URL]"       # empty brackets mean it is unset
psql "$DATABASE_URL" -c '\conninfo'
```

If `\conninfo` reports `Socket Directory | /var/run/postgresql` and
`Password Used | false` while the intended connection string specifies a host
and password, the variable was not set in that shell.

The same applies to `drizzle.config.ts`, which prefers
`DATABASE_URL_DIRECT` and falls back to `DATABASE_URL`. Pass the connection
string explicitly for a migration rather than relying on ambient shell state:

```bash
DATABASE_URL='postgresql://wetalk:<URL_ENCODED_DB_PASSWORD>@<A1_PRIVATE_IP>:5432/wetalk' npm run db:migrate
```

### Worked example

The schema was genuinely behind: migrations `0009`–`0011` had not been
applied. Migration `0010` could not run because `pg_trgm` was missing and the
application role lacked superuser privileges. Creating the extension as
`postgres`, then running `db:migrate` with `DATABASE_URL` explicitly set,
applied all three migrations. The journal grew from 8 rows to 11 and the
`messages` table reported by the application's `42P01` error was created.

## Prepare `pg_trgm` and `btree_gin`

Migration `0010_messages_table.sql` creates a trigram GIN index and requires
the `pg_trgm` extension; `0012_search_extensions.sql` requires `btree_gin` so
the participant columns can live inside that index. The application role is not
a superuser and cannot create either. On a fresh cluster, run this before
migrations:

```bash
sudo -u postgres psql -d wetalk -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
sudo -u postgres psql -d wetalk -c 'CREATE EXTENSION IF NOT EXISTS btree_gin;'
```

Do the same before restoring into a fresh cluster. `pg_restore` running as a
non-superuser cannot create the extensions — see "Verified restore procedure"
for the `must be owner of extension` warnings it emits when they already exist.

## Rotate database credentials

Update `/etc/robot-signal/env` on **all three hosts**, plus any shell profile
that exports `DATABASE_URL`. A missed host crash-loops with
`28P01 invalid_password`.

Passwords containing `@`, `:`, `/`, or `#` must be URL-encoded in the
connection string. Before restarting each service, verify its exact systemd
environment:

```bash
sudo bash -c 'set -a; . /etc/robot-signal/env; set +a; psql "$DATABASE_URL" -c "select 1"'
```

## Managed Redis (OCI Cache / Valkey)

OCI Cache has no public endpoint, so every signaling host reaches it over the
VCN: the cache subnet needs a security list / NSG rule allowing the Redis port
from each signaling host's subnet. Each instance opens five connections — four
from `createRedisPgStores()` (bus pub/sub plus adapter pub/sub) and one for the
shared read cache — so a three-host fleet needs fifteen against the cluster's
connection limit, multiplied again by `SIGNALING_CLUSTER_WORKERS`.

`@socket.io/redis-adapter` needs `createCluster` against a cluster-mode
endpoint and `createRedisPgStores()` calls `createClient`, so use a
non-clustered endpoint (or wire a cluster-aware `opts.createClient`).

### Grant both ACL axes

Keys and pub/sub channels are governed independently and the default is
`resetchannels`. Granting one without the other is the single most common way
to bring a healthy-looking fleet up broken:

- keys but **no channels** — subscribes are refused, so cross-instance fan-out
  never works;
- channels but **no keys** — the service boots cleanly, then fails the
  stale-call sweep every five seconds, so nothing retires stranded `ringing`
  records and users start being told the peer is busy.

Neither is fatal any more: both are logged once (then rate-limited) as
`[redis] <scope> is DEGRADED: NOPERM …` and reported on `/health` under
`redis.issues[]`. Fix the grant:

```redis
ACL SETUSER <CACHE_USER> on >_<CACHE_PASSWORD> ~* &* +@all
```

A narrower grant must still cover the keys `signaling:call:*`,
`signaling:user:*:calls`, `signaling:session:*` and `wetalk:cache:*`, the
channels `signaling:call.transitions`, `signaling:cache.invalidate` and
`socket.io#*`, plus `+@scripting` (the call store's Lua `EVAL` paths) and
`+@keyspace` (the cache's `SCAN`-based prefix deletes).

### Pre-flight the grant before restarting

Run from one signaling host so a bad grant is caught here rather than as a
restart loop:

```bash
sudo -i
set -a; . /etc/robot-signal/env; set +a
redis-cli --tls -u "$REDIS_URL" ACL WHOAMI
redis-cli --tls -u "$REDIS_URL" ACL GETUSER <CACHE_USER>
redis-cli --tls -u "$REDIS_URL" PUBLISH signaling:call.transitions preflight
redis-cli --tls -u "$REDIS_URL" SET signaling:call:preflight ok PX 5000
redis-cli --tls -u "$REDIS_URL" EVAL "return redis.call('GET', KEYS[1])" 1 signaling:call:preflight
redis-cli --tls -u "$REDIS_URL" DEL signaling:call:preflight
```

`PUBLISH` must return an integer (`0` subscribers is fine) and the `SET`/`EVAL`
round trip must return `OK`/`ok`. Any `NOPERM` names the axis still missing.

## Verify fan-out across the fleet

`stateAffinity: "shared"` only says the instance found a `REDIS_URL`; it is not
proof that an event emitted on one host reaches a socket held by another. That
is measured by the active probe in `server/src/lib/fanoutProbe.ts`. Run on
**every** host:

```bash
curl -s localhost:4173/health | jq '{stateAffinity, fanout, instanceId}'
```

```json
{ "stateAffinity": "shared",
  "fanout": { "transport": "redis-adapter", "probing": true,
              "peersSeen": ["1"], "lastPeerEventAgeMs": 445,
              "healthy": true, "mixedTransport": false },
  "instanceId": "0" }
```

`peersSeen` must list the *other* instances, `healthy` must be `true` and
`mixedTransport` `false`. Each host needs a **unique `INSTANCE_ID`** — duplicates
are indistinguishable to the probe as well as to the multi-instance guard.
Probes are emitted every `FANOUT_PROBE_INTERVAL_MS` (default 15s), so wait at
least one interval after a restart before concluding fan-out is broken. Check
`redis.issues[]` in the same response: a non-empty list names a subsystem an ACL
has disabled.

Only when `fanout.healthy` is true on every host should nginx move from
`ip_hash` to round-robin.

A cross-instance call is the end-to-end proof: the caller's and callee's
transitions interleave across hosts on one record.

```
02:37:23  micro2   call.created callerId=<caller> calleeId=<callee> status=ringing
02:37:26  micro1   call.incoming.ack  userId=<callee>
02:37:27  micro1   ringing->accepted           actor=<callee>
02:37:34  micro2   connecting_media->in_call   actor=<caller>
```

## systemd restart backoff

Add these settings to the unit (or a drop-in) so a bad credential cannot cause
an unbounded fast crash-loop:

```ini
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
RestartSec=10
```

Then apply them:

```bash
sudo systemctl daemon-reload
sudo systemctl restart robot-signal.service
```

## Backups

Install [`ops/wetalk-backup.sh`](../ops/wetalk-backup.sh) and the systemd
units in [`ops/systemd/`](../ops/systemd/) on `oci`:

```bash
sudo install -o root -g root -m 0750 \
  /home/wetalk/repos/studious-robot/ops/wetalk-backup.sh \
  /usr/local/bin/wetalk-backup.sh
sudo install -o root -g root -m 0644 \
  /home/wetalk/repos/studious-robot/ops/systemd/wetalk-backup.service \
  /etc/systemd/system/wetalk-backup.service
sudo install -o root -g root -m 0644 \
  /home/wetalk/repos/studious-robot/ops/systemd/wetalk-backup.timer \
  /etc/systemd/system/wetalk-backup.timer
sudo install -o root -g root -m 0644 \
  /home/wetalk/repos/studious-robot/ops/systemd/wetalk-backup-failure.service \
  /etc/systemd/system/wetalk-backup-failure.service
sudo systemctl daemon-reload
sudo systemctl enable --now wetalk-backup.timer
sudo systemctl list-timers wetalk-backup.timer --all
```

> **The repo, `oci`, and `oci-new` are three different configurations.**
>
> | Location | Backup-unit state observed during the 2026-09-24 rebuild |
> | --- | --- |
> | Repository | `EnvironmentFile=`, `OnFailure=wetalk-backup-failure.service`, and supported simple `${BACKUP_HEALTHCHECKS_URL}` expansion |
> | Old `oci` | No `EnvironmentFile=`, no `OnFailure=` or failure unit, and a success-only `curl --config` drop-in |
> | `oci-new` | Repo-style units, but an ad-hoc fix existed only in `wetalk-backup.service`; the failure unit still contained the broken `%/` expression |
>
> Treat the files under `/etc/systemd/system/` as authoritative for what a
> host currently runs and inspect them with `systemctl cat`. Treat the repo as
> authoritative for the next rebuild. Apply a fix to the repo and reinstall
> **both** backup units; a host-only `sed` edit is configuration drift and a
> rebuild will reintroduce the bug. Conversely, installing the repo service
> verbatim on old `oci` would reintroduce `EnvironmentFile=` and `OnFailure=`
> and remove that host's success-ping drop-in.

### The live unit

`/etc/systemd/system/wetalk-backup.service` on `oci` is a `oneshot` unit with:

```ini
[Unit]
After=network-online.target mongod.service postgresql.service

[Service]
Environment=HOME=/root
Environment=OCI_CLI_AUTH=instance_principal
ExecStart=/usr/local/bin/wetalk-backup.sh
TimeoutStartSec=1800
```

Two absences matter:

- **No `EnvironmentFile=`.** systemd does not inject `/etc/robot-signal/env`;
  the script sources it itself (`set -a; . /etc/robot-signal/env; set +a`).
  `DATABASE_URL` and `BACKUP_AGE_RECIPIENT` reach the script that way. A
  variable that is only exported by the unit — not present in that file — will
  be unset at runtime.
- **No `OnFailure=`.** `wetalk-backup-failure.service` never fires on this
  host, so there is no explicit `/fail` ping. Failure is detected *only* by the
  absence of the nightly success ping (dead-man's switch), which means
  detection is delayed by the healthcheck's grace period. When a ping goes
  missing, read `journalctl -u wetalk-backup.service` for the actual cause.

There is one drop-in,
`/etc/systemd/system/wetalk-backup.service.d/healthcheck.conf`, which adds the
`ExecStartPost=` success ping (see "Monitoring").

`wetalk-backup.timer` is enabled and fires nightly at 00:04–00:05 UTC, with
`RandomizedDelaySec` spreading the exact start time.

`env -i` intentionally removes the ambient environment to prove the script can
run non-interactively using only `/etc/robot-signal/env` and its internal OCI
auth:

```bash
sudo -i env -i /usr/local/bin/wetalk-backup.sh
```

Remove and standardise on the timer (do not run cron and timer together):

```bash
sudo rm -f /etc/cron.d/pg-backup
sudo systemctl daemon-reload
```

Use the timer as the single scheduler: it provides journald logs,
`systemctl status`, and failure state. The cron entry sends stderr to root's
local mail spool, which is usually unread.

The script explicitly uses instance-principal authentication, stages the dump
to a temporary file, and refuses to upload files smaller than `MIN_SIZE`
(default: `100000` bytes). Real dumps are ~141 KB following the removal of
~400 users on 2026-09-23; before that removal they were ~1.1 MB. The 100 KB
floor is therefore comfortably below a healthy dump but still catches an empty
or wrong-database dump.

`MIN_SIZE` is measured on the **plaintext** dump, before encryption, so it
compares against `pg_dump` output rather than an `age` payload.

The script also compares the new dump against the previous successful object
size and aborts if the new file is dramatically smaller than
`MIN_PREVIOUS_SIZE_PERCENT` (default: `50`). Unlike `MIN_SIZE`, **both sides of
that comparison are ciphertext**: the new `age` output against the size of the
newest `pg/*.dump.age` object in the bucket. If the previous size cannot be
read, the script logs a warning and falls back to the static `MIN_SIZE` guard.

Two details of that lookup are load-bearing, because getting either wrong
degrades the guard silently to the `MIN_SIZE` floor:

- Objects are keyed `pg/%Y/%m/%d/%H%M%SZ.dump.age`, so the listing uses the
  bare `pg/` prefix. Scoping it to today's date directory finds nothing on the
  first run of a day — exactly the run after an incident, when the guard
  matters most. That key layout also sorts lexicographically in timestamp
  order, so the newest object is the last line.
- The listing passes `--fields name,size` and flattens the CLI's
  pretty-printed, multi-line JSON before matching a `name`/`size` pair. Without
  the fields the size is absent; without the flattening the two keys never
  appear on the same line.

`server/test/ops-backup-script.test.ts` covers both, including the case where
the only previous dump lives under an earlier date directory.

### Encrypted backups

Dumps are encrypted with [`age`](https://github.com/FiloSottile/age) before
anything leaves the host, and are uploaded as `pg/<stamp>.dump.age`.

Install the binary — the script aborts without it:

```bash
sudo apt-get install age
```

The script **fails closed**: if `BACKUP_AGE_RECIPIENT` is unset, or the `age`
binary is missing, the run aborts. It never falls back to uploading a
plaintext dump.

**Generate the key pair off the VM.** Run `age-keygen` on a machine you
control that is not `oci`, keep the `AGE-SECRET-KEY-1…` private key there (or
in a password manager / offline store), and put only the `age1…` public key in
`/etc/robot-signal/env`:

```dotenv
BACKUP_AGE_RECIPIENT=age1<public-key>
```

The threat being addressed is compromise of the host itself. A private key
stored on `oci` would be readable by whoever compromised `oci`, so it would
defeat the entire point of encrypting the backups: the attacker could simply
decrypt every object in the bucket. `oci` must be able to *write* backups it
cannot read back.

Two consequences for the size guards:

- Encryption overhead is small and constant (~230 bytes observed), so ciphertext
  size still tracks dump size closely and the guards keep their meaning.
- The shrink guard compares only against previous `.age` objects. Historical
  plaintext `pg/*.dump` objects predate both the encryption change and the user
  removal and are not a like-for-like baseline, so the script filters them out.

### Monitoring (healthchecks.io)

The live `wetalk-backup.service` pings healthchecks.io only after successful
completion, via an `ExecStartPost=` supplied by the drop-in
`/etc/systemd/system/wetalk-backup.service.d/healthcheck.conf`. Failures or
never-started runs therefore miss the success ping and alert via
dead-man's-switch behavior. There is no `OnFailure=` and so no explicit `/fail`
ping — the missing success ping is the *only* signal.

The drop-in invokes `curl --config /etc/wetalk-backup/healthcheck.curl` rather
than expanding a `${BACKUP_HEALTHCHECKS_URL}` from the environment. This is
deliberate, not drift: the check URL is itself a secret, and keeping it in a
root-owned curl config file keeps it out of the repo, out of
`/etc/robot-signal/env`, and out of `systemctl show` output. Treat it as the
intended pattern. Create it as:

```bash
sudo install -d -o root -g root -m 0700 /etc/wetalk-backup
sudo install -o root -g root -m 0600 /dev/null /etc/wetalk-backup/healthcheck.curl
sudo tee /etc/wetalk-backup/healthcheck.curl >/dev/null <<'EOF'
url = "https://hc-ping.com/<backup-check-uuid>"
EOF
```

Do not commit the real URL.

If you instead use the repo units, set `BACKUP_HEALTHCHECKS_URL` in
`/etc/robot-signal/env` **without a trailing slash**. Both `ExecStart*=` lines
use systemd's supported simple `${BACKUP_HEALTHCHECKS_URL}` expansion. systemd
does not support shell parameter expansion, so
`"${BACKUP_HEALTHCHECKS_URL%/}"` logs

```
wetalk-backup.service: Invalid environment variable name evaluates to an empty string: BACKUP_HEALTHCHECKS_URL%/
```

and pings nothing — both the success ping and the `/fail` ping become inert,
which turns a failing nightly backup into silence rather than an alert. Check
both unit files with

```bash
systemd-analyze verify ./wetalk-backup.service ./wetalk-backup-failure.service
```

Then run `systemctl start wetalk-backup.service` and confirm that the check's
"last ping" time advances; a successful service status alone does not prove
that the `-`-prefixed best-effort ping fired.

### OCI CLI under `sudo -i`

`sudo -i` starts a root login shell that does not inherit
`OCI_CLI_AUTH=instance_principal`. Without it, a manual OCI command prompts to
create `/root/.oci/config`. If that prompt is piped into `pg_restore`, the
misleading result is `input file does not appear to be a valid tar archive`.

Pass authentication explicitly:

```bash
sudo -i /opt/oci-cli/bin/oci os object list \
  --auth instance_principal \
  --bucket-name kiyonbucket \
  --prefix pg/
```

Alternatively, export `OCI_CLI_AUTH=instance_principal` in root's environment.
The backup script already exports it internally.

### Troubleshooting: `BucketNotFound` can mean unauthorized

If backup commands from the VM return `BucketNotFound` or `NamespaceNotFound`
while the Console still shows the bucket and objects, treat it as an IAM access
problem first (Object Storage masks some authorization failures as 404).

1. First, stop exposure growth: take a local dump immediately, independent of
   fixing upload:
   ```bash
   sudo -i bash -c 'set -a; . /etc/robot-signal/env; set +a; pg_dump -Fc -d "$DATABASE_URL" >/var/backups/wetalk-emergency-$(date -u +%Y%m%dT%H%M%SZ).dump'
   ```
2. On the instance, read its OCID from metadata:
   ```bash
   curl -H "Authorization: Bearer Oracle" \
     http://169.254.169.254/opc/v2/instance/
   ```
3. From Cloud Shell (user credentials), check dynamic-group matching rules are
   non-empty and match the instance OCID:
   ```bash
   oci iam dynamic-group list --all \
     --query 'data[].{name:name,rule:"matching-rule"}' \
     --output table
   ```
4. Confirm IAM policy statements still reference that dynamic group and the
   expected bucket.
5. Wait 1-2 minutes after IAM edits for propagation, then retest.
6. Use Audit (retention: one year) to see who/what changed the dynamic group or
   policy.

### Retention and incomplete multipart cleanup

Prefer bucket-side lifecycle rules over client-side deletion. Lifecycle
enforcement does not depend on instance-principal health.

- Add an Object Lifecycle Policy for prefix `pg/` to delete objects older than
  `N` days (operator decision; e.g. 30, 60, or 90 days).
- Also clear incomplete multipart uploads (these are billable and do not appear
  in normal object listings):

```bash
sudo -i /opt/oci-cli/bin/oci os multipart list \
  --auth instance_principal \
  --bucket-name kiyonbucket \
  --all

sudo -i /opt/oci-cli/bin/oci os multipart abort \
  --auth instance_principal \
  --bucket-name kiyonbucket \
  --object-name '<OBJECT_NAME>' \
  --upload-id '<UPLOAD_ID>'
```

## Verified restore procedure

The restore path is: `oci os object get` → `age -d -i <key>` → `pg_restore`.

**Run this on a machine other than `oci`.** The realistic recovery scenario is
one where the VM is gone or compromised, so a procedure that only works on
`oci` has not been verified for the case it exists to cover. It is also where
the `age` private key lives: that key must not be copied onto `oci`. Use a
workstation or a fresh VM with the OCI CLI configured for a *user* principal
(`oci setup config`) — instance-principal auth is only available from `oci`
itself.

Download to a file rather than piping into `pg_restore`. This permits
validation before touching a database and avoids format detection on a
non-seekable stream.

```bash
OBJECT_NAME=pg/<YYYY>/<MM>/<DD>/<HHMMSSZ>.dump.age
ENCRYPTED_FILE=/tmp/wetalk-restore.dump.age
RESTORE_FILE=/tmp/wetalk-restore.dump
AGE_KEY=~/.secrets/wetalk-backup-age.key   # private key; never on `oci`

oci os object list --bucket-name kiyonbucket --prefix pg/ --all \
  --query 'data[?ends_with(name, `.age`)].name'

oci os object get \
  --bucket-name kiyonbucket \
  --name "$OBJECT_NAME" \
  --file "$ENCRYPTED_FILE"

umask 077
age -d -i "$AGE_KEY" -o "$RESTORE_FILE" "$ENCRYPTED_FILE"
```

Spot-check the decrypted dump with `pg_restore --list` before restoring
anything. It parses the archive's table of contents, so a truncated, wrongly
decrypted, or otherwise corrupt file fails here rather than half-way through a
restore:

```bash
pg_restore --list "$RESTORE_FILE" | head -20
```

Then restore into a scratch database. Both extensions the schema depends on
must exist **before** the restore — `pg_trgm` (trigram search) and `btree_gin`
(the participant columns inside that index):

```bash
createdb wetalk_restore_test
psql -d wetalk_restore_test -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
psql -d wetalk_restore_test -c 'CREATE EXTENSION IF NOT EXISTS btree_gin;'
pg_restore --no-owner --dbname wetalk_restore_test "$RESTORE_FILE"
```

Expect this, and do not treat it as a failed restore:

```
pg_restore: error: could not execute query: ERROR:  must be owner of extension btree_gin
pg_restore: error: could not execute query: ERROR:  must be owner of extension pg_trgm
pg_restore: warning: errors ignored on restore: 2
```

Both come from `COMMENT ON EXTENSION` statements in the dump, which only the
extension's owner (normally a superuser) may execute. They are **cosmetic**:
the comment is not applied, no table, index or row is affected, and `errors
ignored on restore: 2` with exactly these two lines is the expected output of a
non-superuser restore. Anything else in that count is not benign — read it.
Verify with the row counts below rather than with the exit status alone.

Compare important row counts with the live TCP database (run the first command
on `oci`, or point `psql` at `DATABASE_URL` from wherever you are restoring):

```bash
sudo bash -c 'set -a; . /etc/robot-signal/env; set +a; psql "$DATABASE_URL" -c "select count(*) from calls"; psql "$DATABASE_URL" -c "select count(*) from call_events"'
psql -d wetalk_restore_test -c 'select count(*) from calls'
psql -d wetalk_restore_test -c 'select count(*) from call_events'
psql -d wetalk_restore_test -c '\dt'
```

Confirm the counts match and `messages` is present, then clean up. The
decrypted dump is plaintext production data — remove it:

```bash
dropdb wetalk_restore_test
shred -u "$RESTORE_FILE" 2>/dev/null || rm -f "$RESTORE_FILE"
rm -f "$ENCRYPTED_FILE"
```

If streaming is unavoidable, specify custom format explicitly:

```bash
oci os object get --bucket-name kiyonbucket --name "$OBJECT_NAME" --file - \
  | age -d -i "$AGE_KEY" \
  | pg_restore -Fc --no-owner -d wetalk_restore_test
```

`pg_restore` cannot auto-detect a custom-format dump from a non-seekable
stream. Downloading first remains preferred because `pg_restore --list`
validates the file before any restore operation.

Historical `pg/*.dump` objects (no `.age` suffix) predate encryption and are
restored the same way with the `age -d` step omitted.

### Periodic restore verification

Run the restore procedure into `wetalk_restore_test` on a fixed schedule (for
example, monthly). Publish results in two places:

- host evidence: `journalctl` output and row-count command output saved with the
  run timestamp;
- operator visibility: update the operations log/issue with pass/fail and the
  restored object name.
