# Grumpy Code Review — copilot/improve-screen-sharing-experience vs master

_Reviewed feff4dea2588073ced6a8b6440dcdbe131a9ea8b..e12c74faa29aaba519735ce294ca29cacff07af5 (plus one follow-up placement fix), 10 files changed._

## Summary

Mergeable. The encoder-parameter capture/restore is correctly guarded and symmetric,
the new tests actually exercise the new code paths (not just re-asserting existing
behaviour), and the full suite/typecheck/lint stay green. The one real defect found —
the new remote-screen-share label being anchored to the bottom of the stage, where it
would sit underneath the in-call control deck — was fixed during this review pass by
moving it to the top slot vacated by the (now local-only) presenter banner.

## Findings

### Critical
None.

### High
None.

### Medium
- **[MEDIUM] Remote screen-share label anchored where the control deck can cover it** — `mobile/src/components/CallStage.tsx` (`remoteScreenShareLabel` style)
  - The label was originally `position: 'absolute', bottom: spacing.sm`, inside `CallStage`, while `CallScreen`'s bottom chrome (`CallBottomOverlay`, holding the entire `CallControls` deck) is a sibling overlay also anchored to the bottom of the same screen area. On any call where the deck's rendered height is larger than a couple of lines, the label report would be visually clipped by the controls sitting on top of it.
  - Fixed in this pass: moved to `top: spacing.sm`, the same slot the local-only presenter banner still uses (`presenterBannerText` is now local-only, so the two never fight for the same space).

### Low
None worth listing — the diff is otherwise consistent with existing patterns (guarded WebRTC calls + `logWarn`, `styles.<key>.color` for icon tinting as already used in `ChatListScreen`/`PeerProfileScreen`).

### Nit
- `mobile/src/callUx.ts`'s `describeScreenShareDelivery` is no longer called from `CallControls` (superseded by the pill's own phrasing) but remains exported and covered by `callUx.test.ts`. Harmless, but worth a follow-up removal if nothing else picks it up.

## Out of scope (pre-existing, not graded)
- Pre-existing Jest teardown noise (`Cannot log after tests are done`, `not wrapped in act`) from `MinimizedCallBanner`/`InCallBanner` timers is unrelated to this diff and reproduces on `master` too.
