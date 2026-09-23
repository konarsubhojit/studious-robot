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

## Prepare `pg_trgm`

Migration `0010_messages_table.sql` creates a trigram GIN index and requires
the `pg_trgm` extension. The application role is not a superuser and cannot
create it. On a fresh cluster, run this before migrations:

```bash
sudo -u postgres psql -d wetalk -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
```

Do the same before restoring into a fresh cluster. `pg_restore` running as a
non-superuser cannot create the extension.

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

> **The repo units and the live units have diverged.** The files in
> `ops/systemd/` are a starting template; they are not a transcript of what
> runs on `oci`. For "what is actually deployed", the units under
> `/etc/systemd/system/` on `oci` are authoritative — read them with
> `systemctl cat wetalk-backup.service`, which also shows the drop-in. Any
> change to backup behaviour must be applied to **both**: edit the repo files
> and install them on the VM, or the next redeploy from the repo will quietly
> revert the VM. Do not assume the commands above leave the VM in its current
> state; installing `ops/systemd/wetalk-backup.service` verbatim would
> reintroduce `EnvironmentFile=` and `OnFailure=` and drop the healthcheck
> drop-in's `ExecStartPost=`.

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
`MIN_PREVIOUS_SIZE_PERCENT` (default: `50`). If the previous size cannot be
read, the script logs a warning and falls back to the static `MIN_SIZE` guard.

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

### OCI CLI under `sudo -i`

`sudo -i` starts a root login shell that does not inherit
`OCI_CLI_AUTH=instance_principal`. Without it, a manual OCI command prompts to
create `/root/.oci/config`. If that prompt is piped into `pg_restore`, the
misleading result is `input file does not appear to be a valid tar archive`.

Pass authentication explicitly:

```bash
sudo -i /home/ubuntu/bin/oci os object list \
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
sudo -i /home/ubuntu/bin/oci os multipart list \
  --auth instance_principal \
  --bucket-name kiyonbucket \
  --all

sudo -i /home/ubuntu/bin/oci os multipart abort \
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

Then restore into a scratch database:

```bash
createdb wetalk_restore_test
psql -d wetalk_restore_test -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
pg_restore --no-owner --dbname wetalk_restore_test "$RESTORE_FILE"
```

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
