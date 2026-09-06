# Load-test results

## 2026-09-05: 10-worker signaling cluster

Both runs used 1,000 users, 20 messages per user per minute, a 300 second hold, and 74,500 messages against the same server from two geographies.

| Metric | Rig A (Singapore) | Rig B (France) |
|---|---:|---:|
| connected / connectFail | 1000 / 0 | 1000 / 0 |
| ack p50 / p95 / p99 / max | 73 / 101 / 117 / 214 | 190 / 216 / 237 / 6020 |
| delivery p50 / p95 / p99 / max | 92 / 119 / 137 / 206 | 207 / 231 / 258 / 6285 |
| errors | `{}` | `{}` |
| rig RSS | 226 MB | 319 MB |

Server-side during rig A: per-core busy stayed between 5.73% and 6.72% across all ten cores; 11 processes were steady with no worker death or respawn; memory stayed at 3.5-3.6 GB; Redis `connected_clients` was flat at 51; Postgres connections were constant at 1; sockets were 1000 during hold and 0 after teardown; and the journal recorded zero errors.

The load spread stayed within about one percentage point across all ten cores. That shows `SO_REUSEPORT` is balancing correctly and no worker became hot. Compared with the single-worker baseline at the same load, p50 improved from 179 ms to 73 ms for acks and from 292 ms to 92 ms for delivery, a 2.5x and 3.2x improvement respectively.

Aggregate CPU was about 0.6 of one core across ten cores, so 1,000 users is far from the ceiling for the clustered server. The run is therefore a validation of even distribution and low queueing, not a capacity limit.

Rig B sits about 117 ms above rig A at every percentile. A constant offset is the signature of network RTT; server-induced load would widen the gap at the tail. The p50-to-p99 spread was 47 ms for B and 44 ms for A, near-identical, confirming the server behaved the same from both origins.

Rig B's 6,020 ms ack `max` against a 237 ms p99 is a single-message outlier in 74,500 messages. The server journal recorded zero errors, zero `transport close`, and zero `ping timeout` for that run, so the outlier never reached the server. It was a network event on the longer path, not a capacity signal.

Postgres held at one connection throughout. This workload is Mongo plus Redis, and the 80-connection Postgres ceiling is not a factor until identity/device writes scale.

The harness at the time of testing lacked the timeout sweeper now present in `/home/runner/work/studious-robot/studious-robot/tools/loadrig/rig.mjs`, so `pending: 0` in these runs reflects zero loss rather than an actively swept queue.
