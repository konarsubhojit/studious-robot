# WeTalk loadrig

`rig.mjs` is a self-contained Socket.IO load-testing harness for the signaling server. Its only non-builtin dependency is `socket.io-client`, kept under `tools/loadrig/` so the server's production dependency graph is unchanged.

## Quickstart

```sh
cd /home/runner/work/studious-robot/studious-robot/tools/loadrig
npm install
TARGET=https://your-server.example node rig.mjs
```

For the standard single-rig 1k run:

```sh
cd /home/runner/work/studious-robot/studious-robot/tools/loadrig
npm install
TARGET=https://your-server.example USERS=1000 MSG_PER_MIN=20 HOLD_SECS=300 RAMP_SECS=120 node rig.mjs
```

## Configuration

All configuration is read from environment variables:

| Var | Default | Units | Meaning |
|---|---:|---|---|
| `TARGET` | required | URL | Base URL of the server under test. The rig exits with code 1 if unset. |
| `USERS` | `1000` | users | Simulated users. Must be even so users can be paired. |
| `USER_OFFSET` | `0` | users | Added to each generated user index (`lt-${USER_OFFSET + i}`) to avoid collisions across rigs. |
| `MSG_PER_MIN` | `20` | messages/user/min | Send rate for each connected simulated user. Use `0` for connection-only tests. |
| `HOLD_SECS` | `300` | seconds | Steady-state duration after the ramp window. |
| `RAMP_SECS` | `120` | seconds | Ramp window used when opening connections. |
| `RAMP_BATCH` | `ceil(USERS / RAMP_SECS)` | connections/second | Connections opened per ramp tick. The derived default guarantees the ramp completes before the hold window; an explicit value below that minimum fails fast. |
| `BODY_BYTES` | `120` | bytes | Size of each text message body. |
| `DELIVERY_TIMEOUT_MS` | `30000` | milliseconds | Age after which an undelivered message is removed from the in-flight map and counted as `delivery_timeout`. |
| `OUT` | `run-<ISO-ish timestamp>.jsonl` | path | JSONL output file. Each report is also written to stdout. |

## Two-rig run

When running from two hosts against one target, split the generated user-id space with `USER_OFFSET`:

```sh
# Host A
TARGET=https://your-server.example USERS=1000 USER_OFFSET=0 node rig.mjs

# Host B
TARGET=https://your-server.example USERS=1000 USER_OFFSET=1000 node rig.mjs
```

Without distinct offsets, both rigs would create the same `lt-*` users and devices, contaminating session and delivery results.

## Choosing load dials

`USERS` and `MSG_PER_MIN` exercise different server limits. `USERS` primarily stresses connection state: worker memory, presence maps, Socket.IO adapter fan-out, and socket bookkeeping. `MSG_PER_MIN` primarily stresses throughput: event-loop time, Redis fan-out, and Mongo write rate. Raising message rate at a fixed user count is usually the cheaper and more isolating experiment because it avoids adding connection-state noise while probing the write/fan-out path.

Latency values are client-side round-trip measurements. They include network RTT between the rig and the server, so compare latency only between runs launched from the same origin unless the network distance is the variable under test.

## Reading output

Every 15 seconds the rig writes a `hold` JSON line, then a final `final` line at teardown. Each line contains:

- `pending`: current in-flight message deliveries, not cumulative loss. Timed-out deliveries are swept after `DELIVERY_TIMEOUT_MS` and counted under `errors.delivery_timeout`.
- `errors`: free-form counters by reason. `{}` means a clean run.
- `ack` / `delivery`: steady-state percentiles; `ackRamp` / `deliveryRamp`: ramp-only percentiles. Ramp noise is kept out of steady-state analysis.
- `rssMB`: rig process resident set size in MB.

A lone high `max` with a tight p99 usually indicates a network event. Server saturation normally widens p95/p99 as queues build rather than producing one isolated outlier.

## Server-side monitoring to run alongside a test

Run these on the server while the rig is active:

```sh
mpstat -P ALL 2
pgrep -af 'node.*server' | wc -l
redis-cli INFO clients | grep '^connected_clients:'
psql "$DATABASE_URL_DIRECT" -c "select count(*) from pg_stat_activity;"
journalctl -u wetalk -f -p warning
```

What bottlenecks look like:

- `mpstat -P ALL 2`: per-core busy should rise evenly when `SO_REUSEPORT` is balancing. One hot core means one worker is taking disproportionate socket or message load; all cores near saturation means CPU is the bottleneck.
- Process count: should stay steady at the expected master plus workers. Drops or churn indicate worker death/respawn under load.
- Redis `connected_clients`: should remain flat after startup. Growth suggests adapter/client leaks or reconnect churn.
- Postgres connection count: should stay below the configured ceiling. Growth or saturation points to identity/device writes rather than Socket.IO fan-out.
- Journal warnings/errors: `transport close`, `ping timeout`, process crashes, or persistence errors distinguish network churn, overloaded event loops, and storage failures from healthy operation.
