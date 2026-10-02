# Task 5 Investigation Report

Source audit: `ab7591677e979d0a86b1137e99743fc5f3bdc5fd`, 2026-10-02.
The retained persistence and proxy-diagnosis rationale is not a new production
incident verification.

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

The server defaults to a 10,000 ms `pingInterval` and an 8,000 ms
`pingTimeout` (`server/src/config.ts`, overridable by
`SOCKET_PING_INTERVAL_MS` and `SOCKET_PING_TIMEOUT_MS`). A healthy connection
therefore exchanges a heartbeat at least every 10 seconds; Engine.IO declares it
dead after a missed heartbeat window of roughly 18 seconds.

The observed 20–60 second idle disconnects are consistent with an intermediary
closing a WebSocket, including a reverse proxy in front of `127.0.0.1:4173`.
`transport close` is the expected Socket.IO symptom when the underlying
WebSocket closes; earlier `ping timeout` entries also support a lost
network/proxy path. Check the proxy's WebSocket upgrade forwarding and idle
timeout, and set its idle timeout comfortably above the heartbeat window (for
example, at least 60 seconds). Keep the current 10s/8s server values unless proxy/mobile
telemetry shows false timeouts: they intentionally detect suspended phones
inside the 120-second default ringing window. If a longer timeout is justified, use a
heartbeat interval/timeout whose combined detection time remains below that
ringing window.
