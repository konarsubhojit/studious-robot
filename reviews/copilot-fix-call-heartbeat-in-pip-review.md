# Grumpy Code Review — copilot/fix-call-heartbeat-in-pip vs c3d64f7

_Reviewed c3d64f7..HEAD, 2 files changed (`mobile/src/hooks/useCallFlow.ts`, `mobile/__tests__/hooks/useCallFlow.test.tsx`)._

## Summary

Mergeable. The diff does the one thing that matters: it stops treating a JS
`setInterval` as the sole proof of call liveness, which is exactly what broke
in Picture-in-Picture, and it does so without touching the wire payload or the
signaling protocol. The heartbeat is time-driven (`lastBeatAtMs` + a due
window) and woken by four sources that do not depend on the JS timer queue, so
an extra wake-up is a no-op and a missed tick is caught up. The worst thing in
it *was* a listener leak on the Engine.IO manager — the manager is shared
between sockets created for the same URL, so `socket.off()` would not have
removed it and every reconnect would have stacked another closure pinning the
hook. That is fixed in this branch (`detachManagerPingRef`) and covered by a
test. `npm test` (1021), `npm run lint` and `npm run typecheck` are clean.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] Engine.IO `ping` listener outlived its socket** — `mobile/src/hooks/useCallFlow.ts` (`connectSocket` / `disconnectSocket`)
  - socket.io-client caches the `Manager` per URL, so a listener added via
    `socket.io.on('ping', …)` is *not* removed by `socket.off()` in
    `disconnectSocket`. Each reconnect (this app reconnects several times an
    hour — see the production log) would have added another handler holding a
    reference to the hook's refs.
  - Duplicate wake-ups are harmless (the due check makes them no-ops), but the
    accumulation is a genuine leak and keeps unmounted hook state alive.
  - Fixed in this branch: the unsubscribe is stored in `detachManagerPingRef`
    and invoked from `disconnectSocket`, asserted by
    "detaches its Engine.IO ping listener when the socket is torn down".

### Low

- **[LOW] `beatCallHeartbeatIfDue` silently drops a beat when the socket is down** — `mobile/src/hooks/useCallFlow.ts` (`beatCallHeartbeatIfDue`)
  - Deliberate (`lastBeatAtMs` is not advanced, so the next wake-up retries,
    and the socket-`connect` wake-up covers the reconnect), and the beat itself
    is logged at `verbose` only. A dropped beat is therefore not visible in a
    default log export — but a *stopped* heartbeat now is, at `info`, which is
    what the incident actually needed. Acceptable; noted so nobody expects a
    warn per skipped beat.

### Nit

- **[NIT] `app-state:${nextState}` trigger strings are free-form** — `mobile/src/hooks/useCallFlow.ts`
  - The trigger is diagnostic-only and never parsed, so a string is fine; a
    union type would be over-engineering for a `logVerbose` field.

## Out of scope (pre-existing, not graded)

- `npm test` prints "A worker process has failed to exit gracefully" both with
  and without this diff (verified against the merge base), caused by
  long-lived timers in tests that never unmount — pre-existing, untouched here.
- The repeated `Socket disconnected {"reason":"transport error"}` roughly every
  4–5 minutes while idle, and the export header reporting
  `socketConnected: false` with no matching disconnect log line, are separate
  problems visible in the same log export and explicitly out of scope.
