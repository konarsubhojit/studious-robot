# Grumpy Code Review — copilot/fix-reconnect-banner-state vs main

_Reviewed 3f4888f..b072ff2, 25 files changed (10 source, 8 test, 1 shared schema, 2 server, plus this report's siblings)._

## Summary

Mostly solid, and unusually well commented for a UX diff: the ladder state is
read rather than rewritten, the vocabulary is shared instead of duplicated for
a third time, and the tests actually pin the new states. Two things stop it
being clean. The worst is on the server: `call.incoming-ack` now causes an emit
to *another user* on the strength of a caller-supplied `callId`, and nothing
checks that the socket sending the ack is the callee. Second, both ringing
screens were narrowed to `severity === 'error'`, which silently swallows the
`warning` statuses the call flow genuinely raises on the answer path
("Call connected, but the camera/microphone is unavailable"). Fix those two
and it merges.

## Findings

### Critical

None. Type-check, lint and the full mobile suite (113 suites / 1760 tests) are
green, and the server suite passes.

### High

- **[HIGH] `call.incoming-ack` can be forged to fake a ringing device** —
  `server/src/signaling/index.ts:330`, `server/src/domain/notifications.ts` (`notifyIncomingCallAcknowledged`)
  - The handler is authenticated, but it never checks that the acking identity
    is the call's callee. `markIncomingCallAcknowledged` had the same trust gap
    and got away with it because it only mutated the server's own push
    bookkeeping. This diff promotes that unchecked `callId` into a
    `call.ringing` emit sent *to the caller*: any authenticated user who learns
    or guesses a live `callId` can tell the caller "their device is awake and
    ringing" when it is not.
  - Why it matters: the caller's screen is now a security surface. The whole
    point of the change is that "Waking their phone" versus "Ringing on their
    device" is trustworthy; a third party being able to flip it makes it worse
    than the ambiguity it replaced, and it also suppresses the push-pending
    wording that would otherwise explain the silence.
  - Fix: in `notifyIncomingCallAcknowledged`, take the acking user id and
    return early unless `call.calleeId === userId`; pass
    `socket.data.identity.userId` from the handler. Cheap, local, and it makes
    the emit as trustworthy as the state it reports.
  - **Resolution: Fixed.** `notifyIncomingCallAcknowledged` now takes the
    acking identity and returns early unless it is the call's callee; the
    signaling handler passes `identity.userId`. Pinned by a new case in
    `server/test/signaling-contract.test.ts` that has a third user ack the
    call id and asserts the caller receives nothing.

### Medium

- **[MEDIUM] Ringing screens now swallow every `warning` status** —
  `mobile/src/components/OutgoingCallScreen.tsx:150`, `mobile/src/components/IncomingCallScreen.tsx:177`
  - The gate was widened from "always render `StatusBanner`" to
    `status?.severity === 'error'`. But `useCallFlow` raises warnings that land
    while these screens are still mounted:
    `'Answering — retrying over a different connection…'`
    (`useCallFlow.ts:3167`), `'Answering — connection still starting…'`
    (`useCallFlow.ts:3173`) and `'Call connected, but the camera/microphone is
    unavailable.'` (`useCallFlow.ts:3219`).
  - Why it matters: the stated goal was to stop the *ringing state* being said
    three times, not to delete degraded-media and retry warnings. A callee who
    answers with a dead camera now gets no explanation at all — the exact
    "invisible distinction" failure this branch exists to remove.
  - Fix: gate on `status?.severity !== 'info'` in both screens, and extend the
    existing tests to assert a `warning` status still renders.
  - **Resolution: Fixed.** Both screens now render the banner for anything that
    is not `info`; `OutgoingCallScreen.test.tsx` and
    `IncomingCallScreen.test.tsx` each assert a `warning` status still shows.

- **[MEDIUM] The new server behaviour has no server test** — `server/test/`
  - `delivery` on `call.ringing`, the offline-callee `'push'` value, and the
    re-emit on `call.incoming-ack` are all untested server-side. The mobile
    half is well covered (`useCallFlow.test.tsx` pins both delivery values and
    the missing-field fallback), so the contract is asserted from exactly one
    end — the end that can't break it.
  - Why it matters: the client's wording depends entirely on this field, and a
    future refactor of `notifyCallCreated` would silently drop it with every
    test still green.
  - Fix: add a case to the existing call signalling suite that connects a
    caller with no callee socket, asserts `delivery === 'push'` on
    `call.ringing`, then emits `call.incoming-ack` from a callee socket and
    asserts a second `call.ringing` with `delivery === 'ringing'`. The
    authorization fix above should be pinned by the same test with a
    third-party socket.
  - **Resolution: Fixed.** Added *"call.ringing tells the caller whether the
    callee rang or was only pushed"* to `server/test/signaling-contract.test.ts`,
    covering `delivery: 'push'` for a socket-less callee, the upgrade to
    `'ringing'` after `call.incoming.ack`, and the forged-ack case.

### Low

- **[LOW] Visible countdown text and its accessible name disagree** —
  `mobile/src/components/OutgoingCallScreen.tsx:118-128`, `mobile/src/components/IncomingCallScreen.tsx:105-112`
  - The rendered string is now `Ringing · 1:58 left` (or `Waking their phone ·
    1:58 left`), while `accessibilityLabel` still says `Rings for 1:58`.
  - Why it matters: WCAG 2.5.3 (Label in Name). A voice-control user reading
    the screen aloud says words the accessible name does not contain, and the
    two now drift independently on every future wording tweak.
  - Fix: build one string (`describeCountdown`) and use it for both the text
    and the label, or drop the redundant label entirely and let the text be the
    name.
  - **Resolution: Fixed.** `describeRingCountdown` in `callUx.ts` returns the
    written and spoken forms of one phrase; both screens use it. The two tests
    asserting the old "Rings for …" label were updated — an intentional wording
    change, not a loosened assertion.

- **[LOW] Local history now overrides the server's end reason** —
  `mobile/src/hooks/useCallFlow.ts` (`endActiveCall`, `resolvedReason`)
  - `resolvedReason` was hoisted above the summary *and* the history write, so
    a locally-detected exhausted ladder records `media_failed` in call history
    even when the server said `ended`. That is almost certainly the intent —
    it is what makes the timeline say "Connection lost" — but the comment only
    justifies the *summary*, so the history divergence reads as a side effect.
  - Fix: extend the comment to say the reason is deliberately recorded in
    history too, so nobody "fixes" it back to the server's value.
  - **Resolution: Fixed.** The comment above `resolvedReason` now says the
    reason is deliberately what call history records.

- **[LOW] Chrome insets are never invalidated between calls** —
  `mobile/src/hooks/usePictureInPicturePip.ts` (`measureChrome`)
  - Keeping the last measurement while the overlay is auto-hidden is correct
    and documented. But the hook lives for the life of the provider, so a
    second call that starts in compact mode inherits the previous call's
    insets until the overlay mounts and re-measures.
  - Why it matters: only a slightly conservative safe region for a few frames —
    no visual break — hence Low.
  - Fix (optional): reset `chromeInsets` alongside the existing
    `hasDefaultPositioned` handling when the stage size drops to zero.
  - **Resolution: Fixed.** `handleCallStageLayout` resets the insets to
    `NO_PIP_CHROME` when the stage collapses to zero.

- **[LOW] `useCallEndAnnouncements` types its parameter the long way round** —
  `mobile/src/AppShell.tsx`
  - `ReturnType<typeof useCall>['callFlow']['callSummary']` re-derives a type
    that is exported by name as `CallEndSummary` from `useCallFlow`.
  - Fix: `summary: CallEndSummary | null`, imported as a type.
  - **Resolution: Fixed.** Imported as `CallEndSummaryData` (the component name
    already owns `CallEndSummary` in that file).

### Nit

- **[NIT] `resolvePipBounds` allocates its default insets on every call** —
  `mobile/src/pipConstants.ts`. Hoist `{ top: 0, bottom: 0 }` to a frozen
  module constant. It runs once per layout, so this is purely tidiness.
  - **Resolution: Fixed.** Hoisted to the exported, frozen `NO_PIP_CHROME`,
    which the hook now also uses as its initial state.
- **[NIT] `RingingAvatar`'s sizes are fixed pixels** —
  `mobile/src/components/RingingAvatar.tsx`. The surrounding codebase caps font
  scaling via `fontScaleCaps`; a 36pt initial in a 100pt disc will clip at
  large accessibility text sizes. Pre-existing behaviour, faithfully moved, so
  not graded — but it is now in one place and therefore cheap to fix later.
  - **Resolution: Deferred.** The sizes are the pre-existing ones, moved
    verbatim; making the ringing avatar font-scale aware changes the look of
    both call screens and belongs with a deliberate typography pass, not with
    this diff.

## Resolution summary

| Severity | Findings | Fixed | Deferred |
|---|---|---|---|
| Critical | 0 | – | – |
| High | 1 | 1 | 0 |
| Medium | 2 | 2 | 0 |
| Low | 4 | 4 | 0 |
| Nit | 2 | 1 | 1 |

Validated after the fixes: `mobile` — `tsc --noEmit`, `eslint`, full Jest suite
(113 suites / 1760 tests) green; `server` — `npm run lint` (now clean, see
below), `tsc --noEmit`, `npm test` (451 tests, 450 pass / 1 pre-existing skip,
66s).

## Out of scope (pre-existing, not graded)

- `server/test/call-history.test.ts:194` failed `@typescript-eslint/no-misused-promises`
  under `npm run lint` in `server/`. Pre-existing on the merge base
  (`3f4888f`, last touched by #204), but it was breaking CI, so it was fixed
  on request: the promise executor now has a block body and `void`s the
  `io.close()` result, matching `signaling-contract.test.ts`'s existing style.
- Mobile Jest still reports leaked handles and needs `--forceExit`; unrelated
  to this branch.
