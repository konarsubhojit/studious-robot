# Load-test results

## 2026-09-05: 10-worker signaling cluster

Historical reported measurements, not a fresh test of the current checkout.
The deployment used the then-current message-store configuration; use the
current PostgreSQL implementation when planning new capacity tests.

Both runs used 1,000 users, 20 messages per user per minute, a 300 second hold, and 74,500 messages against the same server from two geographies.

| Metric | Rig A (Singapore) | Rig B (France) |
|---|---:|---:|
| connected / connectFail | 1000 / 0 | 1000 / 0 |
| ack p50 / p95 / p99 / max | 73 / 101 / 117 / 214 | 190 / 216 / 237 / 6020 |
| delivery p50 / p95 / p99 / max | 92 / 119 / 137 / 206 | 207 / 231 / 258 / 6285 |
| errors | `{}` | `{}` |
| rig RSS | 226 MB | 319 MB |

Server-side during rig A: per-core busy stayed between 5.73% and 6.72% across all ten cores; 11 processes were steady with no worker death or respawn; memory stayed at 3.5-3.6 GB; Redis `connected_clients` was flat at 51; Postgres connections were constant at 1; sockets were 1000 during hold and 0 after teardown; and the journal recorded zero errors.

The reported load spread was narrow, but this run did not measure a capacity
ceiling. Its two geographic rigs are not a controlled isolation of network
RTT from server work, and the historical implementation differs from the
current PostgreSQL path.

Rig B's 6,020 ms ack maximum was a tail outlier against its 237 ms p99.
The reported absence of server journal errors does not by itself locate the
delay or prove that request never reached the server.

The harness at the time lacked the timeout sweeper now present in
`tools/loadrig/rig.mjs`; do not compare its completion accounting directly with
a new run without accounting for that difference.
