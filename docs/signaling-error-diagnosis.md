# Signaling errors during reconnect churn — retained diagnosis

Source audit: `ab7591677e979d0a86b1137e99743fc5f3bdc5fd`, 2026-10-02.

The original incident exposed an observability gap: a rising aggregate error
counter did not identify the rejected event or code in the journal. That
instrumentation is implemented, not pending work.

## Implemented visibility

`server/src/signaling/ack.ts`'s `acknowledgeError` logs code, event, socket,
user and reason. Client-controlled logged fields are flattened/truncated.
When server state is supplied it records the error in telemetry.

`server/src/telemetry.ts` exposes `signaling_errors_by_code` and the more
specific `signaling_errors_stale_call_state_by_event`, with capped label maps.
Use the latter to distinguish stale candidates from stale offers, answers or
media-state frames.

## Remaining counter boundary

`requireSocketSession` and `validateSignalingVersion` still call
`acknowledgeError` without state. Their rejections are logged but not included
in `signaling_errors`. The aggregate is therefore not a count of every
rejection; code/event breakdowns describe only errors recorded with state.

## Reconnect identity

`registerSocketHandlers.ts` resolves identity from the new socket's handshake
and assigns `socket.data.identity` before registering its application event
handlers. Identity is not carried over from the disconnected socket. A
reconnect without a valid session can still fail subsequent session guards;
that is different from losing a valid identity after registration.

## Cleanup and cache interpretation

`scheduleParticipantDisconnectCleanup` schedules a grace timer.
`endCallsForDisconnectedParticipant` skips cleanup while either participant
has live sockets. However, a heartbeat-bearing call also has a heartbeat
expiry in `getCallExpiry`; older claims that all reconnecting calls survive
until the absolute duration cap are too broad.

Message send/delete/read paths invalidate message and conversation caches.
Their cost must be measured against the current invalidation implementation
and workload. An old low cache-hit snapshot does not prove the present cache
is a net loss.

No fresh production trace or counter read accompanied this source audit;
the original incident's dominant rejection cause remains unestablished.
