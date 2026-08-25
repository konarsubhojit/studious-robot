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
| P3.4 | Heartbeat must be an explicit opt-in, not any `call.media-state` frame | ⬜ |
| P2.2 | Delete unreferenced `DraggableCallControls` | ⬜ |
| P1.5 | Server: `express.json` body limit, gate `verboseLog` allocation, Socket.IO buffer/compression tuning | ⬜ |
| P3.3 | Move call timing constants into `shared/` so mobile and server cannot drift | ⬜ |

### Phase 2 — Render performance (P1.1)

| ID | Task | Status |
| -- | ---- | ------ |
| P1.1a | Memoize `ScreenRenderersContext` value; `useCallback` the `TabShell` renderers | ⬜ |
| P1.1b | Move `elapsedCallSeconds` out of the shared hook into `useCallElapsedSeconds` | ⬜ |
| P1.1c | `React.memo` the leaf screens | ⬜ |
| P1.1d | Render-count regression test under fake timers | ⬜ |

### Phase 3 — Startup / bundle

| ID | Task | Status |
| -- | ---- | ------ |
| P1.6a | Metro `inlineRequires` | ⬜ |
| P1.6b | `useThemedStyles` module-level style cache | ⬜ |

### Phase 4 — Server memory

| ID | Task | Status |
| -- | ---- | ------ |
| P1.3 | Evict terminal calls from the hot `state.calls` map after a retention window | ⬜ |

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
