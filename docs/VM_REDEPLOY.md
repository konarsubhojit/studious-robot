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
REDIS_URL=redis://<A1_PRIVATE_IP>:6379
INSTANCE_ID=<UNIQUE_INTEGER>
NODE_ENV=production
```

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
reports shared state and inspect logs if a restart fails:

```bash
sudo journalctl -u robot-signal.service -n 100 --no-pager
```

## Database identity: duplicate `wetalk` databases

There may be a stale, partial local database also named `wetalk`. Bare `psql`,
or `psql "$DATABASE_URL"` when the variable is unset, can connect through the
local Unix socket using peer authentication. The application instead uses the
real database over TCP at the A1 private IP.

Symptoms of querying the wrong database include:

- `\dt` shows only some tables and omits `messages`; the application reports
  `42P01 undefined_table`.
- `drizzle-kit migrate` exits silently because the database it actually
  selected is already migrated.
- `drizzle.__drizzle_migrations` has a different row count between sessions.

**Always run `\conninfo` first:**

```bash
sudo bash -c '
  set -a
  . /etc/robot-signal/env
  set +a
  echo "[$DATABASE_URL]"
  test -n "$DATABASE_URL"
  psql "$DATABASE_URL" -c "\conninfo"
  psql "$DATABASE_URL" -c "\dt"
  psql "$DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations"
'
```

If connection information reports `Socket Directory | /var/run/postgresql`
and `Password Used | false`, it is the local socket database, not the TCP
database. Never draw schema conclusions until the connection string is passed
explicitly and `echo "[$DATABASE_URL]"` proves it is non-empty.

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

Install [`ops/wetalk-backup.sh`](../ops/wetalk-backup.sh) as
`/usr/local/bin/wetalk-backup.sh` on `oci`:

```bash
sudo install -o root -g root -m 0750 \
  /home/wetalk/repos/studious-robot/ops/wetalk-backup.sh \
  /usr/local/bin/wetalk-backup.sh
sudo -i env -i /usr/local/bin/wetalk-backup.sh
```

The script explicitly uses instance-principal authentication, stages the dump,
and refuses to upload files smaller than `MIN_SIZE` (default: 15000 bytes).
Healthy dumps for the small observed dataset were approximately 24–32 KB. A
sudden drop indicates that the wrong or an empty database is being dumped.

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

## Verified restore procedure

Download to a file rather than piping into `pg_restore`. This permits
validation before touching a database and avoids format detection on a
non-seekable stream.

```bash
OBJECT_NAME=pg/<YYYY>/<MM>/<DD>/<HHMMSSZ>.dump
RESTORE_FILE=/tmp/wetalk-restore.dump

sudo -i /home/ubuntu/bin/oci os object get \
  --auth instance_principal \
  --bucket-name kiyonbucket \
  --name "$OBJECT_NAME" \
  --file "$RESTORE_FILE"

sudo -u postgres pg_restore -l "$RESTORE_FILE" | head -20
sudo -u postgres createdb wetalk_restore_test
sudo -u postgres psql -d wetalk_restore_test \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
sudo -u postgres pg_restore --no-owner \
  --dbname wetalk_restore_test "$RESTORE_FILE"
```

Compare important row counts with the live TCP database:

```bash
sudo bash -c 'set -a; . /etc/robot-signal/env; set +a; psql "$DATABASE_URL" -c "select count(*) from calls"; psql "$DATABASE_URL" -c "select count(*) from call_events"'
sudo -u postgres psql -d wetalk_restore_test -c 'select count(*) from calls'
sudo -u postgres psql -d wetalk_restore_test -c 'select count(*) from call_events'
sudo -u postgres psql -d wetalk_restore_test -c '\dt'
```

Confirm the counts match and `messages` is present, then clean up:

```bash
sudo -u postgres dropdb wetalk_restore_test
sudo rm "$RESTORE_FILE"
```

If streaming is unavoidable, specify custom format explicitly:

```bash
oci os object get --auth instance_principal ... --file - \
  | sudo -u postgres pg_restore -Fc --no-owner -d wetalk_restore_test
```

`pg_restore` cannot auto-detect a custom-format dump from a non-seekable
stream. Downloading first remains preferred because `pg_restore -l` validates
the file before any restore operation.
