# Optimization Plan — UI, Architecture & Performance

Tracking document for the UI / architecture / performance pass. Each task is
sized to land independently behind the existing `backend-ci.yml` /
`mobile-ci.yml` typecheck + test gates. No task weakens or removes an existing
test.

## Operating assumptions

These were confirmed before work started and they materially shape the scope:

| Question | Answer | Consequence |
| -------- | ------ | ----------- |
| Instance count | **Single instance** today | P3.1 is a documentation + startup-assertion task, not a Redis state refactor |
| Concurrent users | **~10** | P1.4 (directory paging / lazy boot hydration) is premature; descoped to a documented note |

Everything else in the original plan stands.

## Status

Legend: ✅ done · 🚧 in progress · ⬜ not started · ⏸️ descoped (with reason)

### Phase 1 — Quick wins, low risk

| ID | Task | Status |
| -- | ---- | ------ |
| P3.4 | Heartbeat must be an explicit opt-in, not any `call.media-state` frame | ✅ already fixed on `master` — verified the `heartbeat === true` guard in `callHandlers.ts` and the regression test in `stale-calls.test.ts`; no change needed |
| P2.2 | Delete unreferenced `DraggableCallControls` | ✅ deleted, with its test |
| P1.5 | Server: `express.json` body limit, gate `verboseLog` allocation, Socket.IO buffer cap | ✅ see note on compression below |
| P3.3 | Move call timing constants into `shared/` so mobile and server cannot drift | ✅ `shared/signaling/timing.ts`, with an invariant test |

### Phase 2 — Render performance (P1.1)

| ID | Task | Status |
| -- | ---- | ------ |
| P1.1a | Memoize `ScreenRenderersContext` value; `useCallback` the `TabShell` renderers | ✅ |
| P1.1b | Move `elapsedCallSeconds` out of the shared hook into `useCallElapsedSeconds` | ✅ |
| P1.1c | `React.memo` the leaf screens | ✅ |
| P1.1d | Render-count regression test under fake timers | ✅ |

### Phase 3 — Startup / bundle

| ID | Task | Status |
| -- | ---- | ------ |
| P1.6a | Metro `inlineRequires` | ✅ |
| P1.6b | `useThemedStyles` module-level style cache | ✅ |

### Phase 4 — Server memory

| ID | Task | Status |
| -- | ---- | ------ |
| P1.3 | Evict terminal calls from the hot `state.calls` map after a retention window | ✅ |

### Phase 5 — Architecture & docs

| ID | Task | Status |
| -- | ---- | ------ |
| P3.1 | Document the single-instance requirement + surface it at startup and in `/health` | ⬜ |
| P1.4 | Directory / boot-hydration scaling | ⏸️ descoped — premature at ~10 concurrent users |
| P3.2 | Reformat single-line wide type declarations | ⬜ |

### Deferred beyond this pass

| ID | Task | Reason |
| -- | ---- | ------ |
| P1.2 | Decompose `useCallFlow` (3.6k lines) | Large structural refactor; wants its own PR and its own review. P1.1b removes the timer that made it a *performance* problem, leaving it a pure maintainability item |
| P1.6c | Enable R8 / `shrinkResources` for release builds | Real crash risk without device QA on the release APK |
| P1.7 | Swap `chatDb` JSON document for SQLite | Bound at 200 messages × 100 conversations, so defensible today. Flagged so the bound is not raised casually |
| P2.1 | Port `MediaViewer` / `SwipeableRow` to Reanimated worklets | Behavioural gesture rewrite; wants device QA |
| P2.3–P2.5 | Accessibility sweep, state completeness, design-system consolidation | Broad UI surface; sequenced after the perf work that changes how those screens render |

## Notes and deviations

### P3.4 was already fixed
The finding in `reviews/copilot-master-review.md` is stale. `handleRtcRelay`
already requires `mediaState.heartbeat === true` before stamping liveness, and
`stale-calls.test.ts` already asserts that a plain screen-share frame does not
refresh the deadline. Verified rather than re-implemented.

### P1.5: no `compression` middleware
Deliberately skipped. It would add a runtime dependency to save bandwidth on
JSON payloads that are already small (a chat body is capped at 4000 characters)
for a deployment serving ~10 concurrent users. The other three items in P1.5 —
an explicit body limit, gating the verbose-logging allocation, and a Socket.IO
frame cap — cost nothing and were done. Revisit compression if payload sizes or
the user count change materially.

### P3.3: behaviour is unchanged
The server's heartbeat timeout was the literal `150_000`; it is now derived as
`CALL_HEARTBEAT_INTERVAL_MS * CALL_HEARTBEAT_MISSED_BEAT_ALLOWANCE`
(`30_000 * 5`), which is the same number. `heartbeat-timing.test.ts` pins the
values so the move cannot have changed behaviour and the two edges cannot drift
apart again.

### P1.1: what actually changed

The root cause was that `useCallFlow` returns a fresh object on every render and
ticked `elapsedCallSeconds` once a second. That made the `CallProvider` context
identity change every second, which changed the `ChatProvider` context derived
from it, which re-rendered every mounted screen — including an open conversation
and all of its message bubbles — for the entire duration of every call.

The fix inverts the direction of the data: `useCallFlow` now publishes
`callConnectedAtMs`, a value that changes exactly twice per call, and the two or
three components that display a duration derive the seconds locally through
`useCallElapsedSeconds`. The timer no longer crosses a provider boundary at all.

`callTimerRenderIsolation.test.tsx` locks this in. It asserts both halves of the
property — that five seconds of call time advance the banner while leaving the
tab shell's render count untouched, *and* that a genuine state change still
re-renders the shell, so the first assertion cannot silently degrade into
"nothing is being counted".

Note on P1.1c: `React.memo` on the leaf screens is defence in depth rather than
the main win. Because the screens are reached through the `render*` indirection,
the effective guard is that those renderers are now stable, so the route
components do not re-render and the elements are never recreated. The `memo`
wrappers matter for the paths where a parent re-renders for an unrelated reason.

### P1.3: retention is also the history horizon

`GET /calls` reads history straight out of the in-memory `state.calls` map
rather than out of Postgres, so the retention window is not purely an internal
memory bound — it is also how far back that endpoint can see. Eviction is
therefore deliberately conservative:

- Only calls in a terminal state are ever evicted. A live call is state, not
  history, and stays until the existing timeout sweep closes it.
- The age pass uses `updatedAt`, which is stamped at the moment the call reached
  its terminal state, and defaults to a 24h window.
- A count ceiling (500, oldest-first) catches a burst that lands entirely inside
  one window, so the map is bounded on both axes.
- `state.callEvents` is evicted in step with `state.calls`; otherwise the leak
  just moves from one map to the other.

Both bounds are configurable (`CALL_RETENTION_MS`, `MAX_RETAINED_CALLS`). At the
target of ~10 concurrent users neither will realistically be reached, so this is
a leak fix rather than a behaviour change. **If deeper call history is wanted
later, the fix is to move the `GET /calls` read path onto the durable `calls`
table (already written by `callPersistence.ts`) rather than to raise the
retention window.**
