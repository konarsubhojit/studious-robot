# Grumpy Code Review — copilot/master vs master

_Reviewed c2ddc57..7ecb0f1, 19 files changed._

## Summary

The core fix is right: nothing ever advanced a call past `connecting_media`, so the
sweep guillotined every healthy call, and this branch adds the missing
`call.connected` report plus a sweep exemption and a regression guard. Tests, lint
and typecheck are green on both packages. The worst thing in it is that the new
heartbeat treats *any* `call.media-state` frame as proof of liveness — including the
screen-share toggles emitted by clients that predate this protocol change — so an
abandoned call can be kept alive by an unrelated UI event. Tighten that and this is
mergeable.

## Findings

### Critical

None.

### High

- **[HIGH] Any `call.media-state` frame counts as a heartbeat** — `server/src/signaling/callHandlers.js` (`recordsHeartbeat` branch in `handleRtcRelay`)
  - `recordCallHeartbeat` is called for *every* `call.media-state` frame, but only the
    new client's periodic beat is actually a liveness signal. The same event is
    emitted by today's shipped client whenever screen sharing is toggled, and by the
    new client for the same reason. A stray toggle therefore refreshes the deadline
    on a call nobody is on, and the "abandoned call" case the heartbeat exists to
    detect goes undetected for up to the 4h cap.
  - It also makes the deadline's meaning version-dependent, which is exactly the kind
    of ambiguity that turns into the next `media_connect_timeout`-shaped outage.
  - Fix: only treat a frame as a heartbeat when the payload explicitly opts in
    (`mediaState.heartbeat === true`), and cover it with a test asserting a plain
    screen-share frame does not refresh `lastHeartbeatAt`.

### Medium

- **[MEDIUM] `iceState` is read before the payload is validated** — `server/src/signaling/callHandlers.js:handleCallConnected`
  - The handler branches on `payload?.iceState` before `handleSocketCallTransition`
    validates the payload against the schema. The blast radius is small (an invalid
    payload is still rejected downstream, and a non-string falls back to
    `'connected'`), but reading unvalidated input to pick a *destination state* is the
    kind of thing that rots into a real bug.
  - Fix: acceptable as-is only because the schema rejects anything that reaches the
    transition; leave a comment saying so, or restructure the shared handler to hand
    the parsed payload to a `resolveTransition` callback.

### Low

- **[LOW] `unref()` on a React Native timer is a no-op** — `mobile/src/hooks/useCallFlow.js` (`reportMediaFailure`)
  - `iceFailureTimerRef.current?.unref?.()` is defensive Node-ism; RN's `setTimeout`
    returns a number. Harmless, but it implies a guarantee the runtime does not give.
  - Fix: drop it, or keep it with a comment that it only matters under the Jest/Node
    test environment.

- **[LOW] Grace period and heartbeat interval are duplicated constants across packages** — `mobile/src/hooks/useCallFlow.js:CALL_HEARTBEAT_INTERVAL_MS` vs `server/src/config.js:CALL_HEARTBEAT_INTERVAL_MS`
  - The two must stay in a fixed ratio to the server's `DEFAULT_CALL_HEARTBEAT_TIMEOUT_MS`
    or calls die early. They are commented as mirrors but nothing enforces it.
  - Fix: if this drifts again, move the interval into `shared/` where both edges
    already import the protocol constants.

### Nit

- **[NIT] `getCallExpiry` is now exported purely for the regression test** — `server/src/domain/calls.js`
  - Defensible (the guard test is the point of the export) but it widens the module's
    public surface. Worth a one-line comment on the export saying it is exposed for
    the state-machine invariant test.

## Out of scope (pre-existing, not graded)

- `mobile/src/components/DraggableCallControls.js` renders a second copy of
  `CallControls` but is not referenced by any screen — dead code that predates this
  branch, and a plausible source of the "duplicate control deck" report if it is ever
  wired back up.
- `mobile/src/components/SwipeableRow.js` is built on `PanResponder` rather than
  `react-native-gesture-handler`; the file documents the reasoning. Not touched
  behaviourally by this diff beyond the added haptic and accessibility actions.
- The `stage=ui_displayed reason=connection_missing` / 4s push-latency items from the
  report are diagnosis work on the CallKeep and Notification Hub paths; no code in
  this diff addresses them.
