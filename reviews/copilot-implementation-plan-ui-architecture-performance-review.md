# Grumpy Code Review — copilot/implementation-plan-ui-architecture-performance vs origin/master

_Reviewed 760e230..717eadb, 118 files changed (+3951 / −1131)._

## Summary

Mergeable. This is a large branch — five optimization phases plus the deferred
backlog — but it is disciplined: every behavioural change is pinned by a test,
the suites are green on both sides of the merge base (mobile 82→87 suites,
1035→1082 tests; server 391→411 tests, all passing), and typecheck and lint are
clean. The worst thing in it *was* the `PanResponder`→Reanimated port: the
media viewer's pan `onEnd` is compiled to a UI-thread worklet by the Reanimated
Babel plugin, and it called `resolveMediaGesture`, a plain module-scope
function, which does not exist in the UI runtime — every completed drag would
have thrown on a real device while the jest mocks (which run callbacks on the JS
thread) reported success. That is now fixed with a `'worklet'` directive, and
the same pass memoized both gesture definitions and closed a
`nextStatus`/`resolveTransition` type hole on the server. What is left is
consistency and follow-through nits.

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low

- **[LOW] `TabShell`'s new `useCallback`s depend on whole context objects, so four of six screen renderers still change identity every render** — `mobile/src/components/TabShell.tsx:101,170,205,240`
  - `renderChatConversation`, `renderPeerProfile`, `renderCalls` and
    `renderSettings` list `callFlow` and/or `chat` — the entire context values —
    in their dependency arrays. Those objects are rebuilt whenever their
    provider re-renders, so the callbacks are rebuilt too, which rebuilds the
    `screenRenderers` memo in `AppNavigator.tsx:219` that this work exists to
    stabilise.
  - Why it matters: the stated goal was to stop a provider update from
    re-rendering every mounted route. It is achieved for `renderChatList` and
    `renderSearch` (which list only the fields they use) and for re-renders
    caused by anything other than a context change; for the rest, the
    memoization is bookkeeping that never pays out.
  - Fix: destructure the specific members each renderer uses (as
    `renderChatList` already does) and list those instead of the container
    object.

- **[LOW] `handleCallConnected` smuggles `iceState` out of the transition resolver through a mutable outer binding** — `server/src/signaling/callHandlers.ts:269-291`
  - `let iceState = 'connected'` is declared, reassigned inside
    `resolveTransition`, and read again inside `onSuccess` purely to build a log
    line. It is correct today only because `handleSocketCallTransition` calls
    both callbacks synchronously within one invocation.
  - Why it matters: nothing in the type or the signature says so. The day that
    helper awaits anything between resolving and succeeding, the log silently
    reports the wrong ICE state — a debugging trap, not a crash.
  - Fix: carry it on the return value — widen `CallTransition` with an optional
    `iceState?: string` — and read it from the `transition` argument `onSuccess`
    already receives.

- **[LOW] `pruneTerminalCalls`'s signature is a 200-character single line, in a diff whose stated purpose was to stop writing those** — `server/src/domain/calls.ts:333`
  - The branch wraps roughly two dozen `type`/`interface` declarations onto
    multiple lines and adds `declaration-formatting.test.ts` plus an eslint
    `max-len` to enforce it — but both only police `type`/`interface` lines, so
    this new function declaration with a four-field inline options object slid
    straight past.
  - Why it matters: it is exactly the unreviewable-in-a-diff shape the rest of
    the branch spent effort eliminating, one rule-scope away from being caught.
  - Fix: hoist the options object to a named `PruneTerminalCallsOptions` type
    (which the existing checks *would* then format-check) and wrap the
    signature.

- **[LOW] `CALL_RETENTION_MS=0` / `MAX_RETAINED_CALLS=0` silently mean "use the default", not "disable"** — `server/src/createServer.ts:299-302`
  - `Number(process.env.CALL_RETENTION_MS) || DEFAULT_CALL_RETENTION_MS` treats
    `0` as falsy. Meanwhile `pruneTerminalCalls` explicitly guards
    `if (maxAgeMs > 0)` and `if (maxRetainedCalls > 0)`, i.e. the function
    documents `0` as "skip this pass" — a meaning the env parsing makes
    unreachable.
  - Why it matters: an operator disabling age-based pruning during an incident
    gets 24-hour retention instead and no warning. The same pattern equally
    turns a typo (`CALL_RETENTION_MS=abc` → `NaN`) into the default silently.
  - Fix: parse once with `Number.isFinite` and fall back only when the value is
    not a finite non-negative number.

### Nit

- **[NIT] `resolveMediaGesture` is now both an exported pure helper and a worklet** — `mobile/src/components/MediaViewer.tsx:46-58`
  - The `'worklet'` directive is required (see Summary) but makes the function
    dual-natured: it is unit-tested from the JS thread and executed from the UI
    thread. Nothing enforces that it stays worklet-safe — a future contributor
    adding, say, a `logVerbose` call to it would reintroduce the crash the
    directive just fixed.
  - Fix: nothing to change today; the docstring already says why the directive
    is there. If more shared gesture maths accumulates, move it to a
    `gestureMath.ts` whose module docstring makes "worklet-only, no imports"
    the rule for the whole file.

- **[NIT] `useThemedStyles`' module-scope cache quietly requires factories to be module-level constants** — `mobile/src/ThemeContext.ts:70-90`
  - Keying a `WeakMap` on the factory means a factory defined *inside* a
    component would be a new key on every render — no stale styles, but no cache
    hits either, and a slow churn of entries that live until GC. Every current
    caller passes a module constant, and the docstring says so.
  - Fix: none needed; noting it so the invariant is not lost.

## Out of scope (pre-existing, not graded)

- `npx jest` prints "A worker process has failed to exit gracefully" on both the
  merge base and this branch. It predates the diff and does not fail the run.
- `server/src/domain/calls.ts`, `messageStore.ts` and `createServer.ts` keep
  their pervasive `any` typing on stats, stores and the Socket.IO server. The
  diff touches those lines but does not widen the practice.
- Sessions, calls and presence remain per-process maps; the branch documents
  the sticky-routing requirement (`/health` `stateAffinity`, startup warning)
  rather than fixing it, which is the right call for this change but leaves the
  underlying constraint in place.
