# Task 5 Investigation Report

## Call-event persistence finding

The checked-in `call_events` schema has nullable `text` columns for both
`actor` and `reason`; neither the Drizzle schema nor migration has an enum,
CHECK, or `NOT NULL` constraint that rejects `''`. Empty strings therefore
cannot, by themselves, explain an insert failure against this schema. The
different outcomes for two structurally identical `created` events likewise
cannot be explained by the reported empty `reason`: the successful deployment
either had different values, a different deployed schema/trigger, or a
transient database failure. The database error code and message in the existing
event-persistence log are needed to distinguish those cases.

Absent event values are now normalized to `null` while constructing the domain
event, rather than at the database boundary. Event persistence remains
non-blocking: a failed audit write must not interrupt an active call, but it is
not silently ignored—the event id, call id, event type, database error code,
and message are logged for remediation.

## (a) Socket `transport close` churn

The server configures Socket.IO with a 10,000 ms `pingInterval` and a 10,000 ms
`pingTimeout` (`server/src/config.js`, overridable by
`SOCKET_PING_INTERVAL_MS` and `SOCKET_PING_TIMEOUT_MS`). A healthy connection
therefore exchanges a heartbeat at least every 10 seconds; Engine.IO declares it
dead after a missed heartbeat window of roughly 20 seconds.

The observed 20–60 second idle disconnects are consistent with an intermediary
closing a WebSocket, including a reverse proxy in front of `127.0.0.1:4173`.
`transport close` is the expected Socket.IO symptom when the underlying
WebSocket closes; earlier `ping timeout` entries also support a lost
network/proxy path. Check the proxy's WebSocket upgrade forwarding and idle
timeout, and set its idle timeout comfortably above 20 seconds (for example,
at least 60 seconds). Keep the current 10s/10s server values unless proxy/mobile
telemetry shows false timeouts: they intentionally detect suspended phones
inside the 30-second ringing window. If a longer timeout is justified, use a
heartbeat interval/timeout whose combined detection time remains below that
ringing window.

## (b) `409 identity_conflict` after re-registration

This is not an asynchronous identity-release race. The mobile unregister path
only calls `POST /devices/unregister` and clears local identity storage.
`/devices/unregister` clears the device push token; it does not delete sessions,
the user record, or the salted verification-code hash. `resolveIdentityClaim`
intentionally retains a claimed identity and returns 409 unless the same
verification code is presented. Persisted claims also survive a restart.

The reported 55-second/17-second timing therefore has no server-side claim
release to race. It is likely explained by client state/session timing or a
subsequent request that included the recovery code, not by unregister. The
client's generic 409 message is misleading for a user who already owns the
identity: it should say to enter the existing recovery code rather than suggest
signing out or choosing another username. No code change was made because this
task requested investigation and reporting only.
