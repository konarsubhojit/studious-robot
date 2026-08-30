# Grumpy Code Review — copilot/phase-5-decompose-usecallflow vs main

_Reviewed 4dca3d0..2ac82a8, 15 files changed (+2907 / −427)._

## Summary

Mergeable. This is a genuine rules-out/effects-stay decomposition, not a
file-shuffle: `useCallFlow.test.tsx` is byte-identical to the base branch and
still passes, the hook's return shape is untouched, `npm run typecheck` is
clean, and the package lint warning count is unchanged at 24 (all pre-existing,
none in `useCallFlow.ts` any more). 2081 tests across 123 suites pass. The
worst thing in it is a documentation claim that is simply false — the P1.2 note
credits the diff with URL-encoding a callId that the base branch already
encoded — plus a non-null assertion that quietly defeats the type narrowing the
new classifier was supposed to provide. Neither is dangerous; both are sloppy.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] Non-null assertion throws away the narrowing the classifier exists to provide** — `mobile/src/hooks/useCallFlow.ts` (`acceptCallOverHttp`, `return response!.json()`)
  - `classifyHttpAccept` returns `{ outcome: 'ok' }` only when `response` is
    truthy and `ok`, but that relationship is invisible to TypeScript, so the
    call site papers over it with `!`. If anyone ever adds a third outcome, or
    relaxes the `!response` branch in `classifyHttpAccept`, this becomes a
    runtime `Cannot read properties of undefined` on the answer path — the one
    path in the app that must never fail.
  - Why it matters: the whole point of moving the classification out was to
    make the failure cases explicit. A `!` re-hides them.
  - Fix: have `classifyHttpAccept` narrow for the caller — either return the
    response in the `ok` variant, or keep an explicit `if (!response) throw`
    before the classifier so TS narrows naturally.
  - **Resolution: Fixed.** `classifyHttpAccept` is now generic over the
    response type and returns it in the `ok` variant; `acceptCallOverHttp`
    reads the body off `verdict.response`, and the `!` is gone.

- **[MEDIUM] Two nearly identical call-URL builders in two modules** — `mobile/src/call/pushRehydration.ts` (`buildCallLookupUrl`) and `mobile/src/call/answerPath.ts` (`buildCallActionUrl`)
  - Both trim the signaling URL, append `API_ROUTES.CALLS`, and
    `encodeURIComponent` the callId; they differ only in the suffix (a query
    string versus a path segment). That is one rule about how this app
    addresses a call, written twice.
  - Why it matters: the escaping is a security-relevant detail. Two copies is
    two places for someone to later "simplify" one of them.
  - Fix: not worth churning the two modules in this PR, but the next slice that
    touches either should collapse them onto a single
    `callResourceUrl({ signalingUrl, callId })` and let the callers append.
    Noted here so it isn't lost.
  - **Resolution: Fixed.** Both builders moved to a new
    `mobile/src/call/callEndpoints.ts` over one private `callResourceUrl`, so
    the escaping rule is written once; their tests moved with them to
    `__tests__/call/callEndpoints.test.ts`.

### Low

- **[LOW] The P1.2 note claims a hardening that the diff did not perform** — `docs/OPTIMIZATION_PLAN.md` ("Two hardening details came with the move — the callId is now URL-encoded…")
  - The base branch already wrote
    `` `${trimmedUrl}${API_ROUTES.CALLS}/${encodeURIComponent(callId)}` `` at all
    three call sites (`git show 4dca3d0:mobile/src/hooks/useCallFlow.ts`,
    lines 2675, 3136, 3429). The encoding was preserved by the move, not
    introduced by it.
  - Why it matters: this document is the project's record of what each slice
    actually changed. A false credit in it makes every other claim in it worth
    less. The *other* half of that sentence — the `Object.hasOwn` lookup — is
    real: the base branch's `terminalMessages[call.status]` would have returned
    `Object.prototype.constructor` for a status of `constructor` and the `??`
    fallback would not have fired.
  - Fix: reword to say the encoding was preserved, and keep only the
    prototype-lookup fix as a hardening.
  - **Resolution: Fixed.** The P1.2 note now says the escaping was preserved
    rather than introduced, and credits only the `Object.hasOwn` lookup.

### Nit

- **[NIT] Stray trailing blank line** — `mobile/src/audioRouting.ts:391`
  - Left behind when the routing rules were relocated to
    `call/audioRouteRules.ts`. The file's only change in this diff is a blank
    line, which makes it look like it was touched for no reason.
  - Fix: delete it so the file drops out of the diff entirely.
  - **Resolution: Fixed.** Removed; `audioRouting.ts` is byte-identical to the
    base branch again.

## Resolution summary

4 findings, 4 fixed, 0 deferred: 2 Medium, 1 Low, 1 Nit. Re-validated after the
fixes — `npm run typecheck` clean, lint at the same 24 pre-existing warnings,
2081 tests across 124 suites green, `useCallFlow.test.tsx` still unmodified.

## Out of scope (pre-existing, not graded)

- 24 `sonarjs/cognitive-complexity` warnings remain package-wide (e.g.
  `mobile/src/webrtcConfig.ts:239`). All are catalogued in
  `docs/complexity-baseline.md` and none are in files this diff is responsible
  for; the count is identical to the base branch.
- `chooseAudioRoute` performs its Bluetooth permission check outside its `try`
  (`mobile/src/audioRouting.ts`). Recorded in the review ledger and explicitly
  out of scope for #216.
- There is still no E2E coverage of the call path (#114), so every slice in
  this PR depends on the device-QA checklist in #216 being run by a person.
  That checklist is outstanding.
