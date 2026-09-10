# Grumpy Code Review — copilot/fix-message-ordering vs master

_Reviewed b9e114ff7b60122f51a264f0d8954328b374eaa8..3109f74, 13 files changed._

## Summary

Mergeable. The diagnosis is right and the fix is put in the right places: one
normaliser at the store boundary, one at the mobile ingest point, and instant
comparisons where two differently-shaped timestamps used to be compared as
text. Lint, typecheck and both test suites are clean against the baseline, and
the claim that normalisation is lossless is actually verified rather than
asserted (`createdAt`/`readAt`/`deletedAt` are only ever written by
`nextTimestamp()`, which is `toISOString()`, so the `before` cursor's
equality tie-break is untouched). The worst thing in it is a docstring that
promises more than the code delivers: `normalizeTimestamp` says it returns a
value unchanged when it cannot be understood, and then silently rolls
`2026-13-45` over into `2027-02-14`. Nothing reachable feeds it that, but a
module whose whole job is "be strict about shape" should not be the lenient
one. Everything else is small.

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low

- **[LOW] `normalizeTimestamp` silently rewrites out-of-range date components instead of passing them through** — `shared/time.ts:100-119`
  - The module's own contract (`shared/time.ts:79-88`) says a value it
    "cannot be understood at all" is returned unchanged, because "a timestamp
    this module does not recognise is someone else's data, and mangling it
    would be worse than passing it along". `TIMESTAMP_TEXT` matches `\d{2}`
    for month, day, hour, minute and second without bounding them, and
    `setUTCFullYear`/`setUTCHours` roll over rather than reject. Measured:

    | input | output |
    |---|---|
    | `2026-13-45 00:00:00+00` | `2027-02-14T00:00:00.000Z` |
    | `2026-02-30 00:00:00+00` | `2026-03-02T00:00:00.000Z` |
    | `2026-00-00 00:00:00+00` | `2025-11-30T00:00:00.000Z` |
    | `2026-09-09 25:99:99+00`  | `2026-09-10T02:40:39.000Z` |

  - Why it matters: not reachable from Postgres or `toISOString()`, so no user
    hits this today — but `chatDb.sanitizeSnapshot` exists precisely to make a
    corrupt on-disk file degrade to "less history", and this turns a garbage
    timestamp into a confident, wrong one that then sorts a bubble into a
    plausible-looking position. Being wrong quietly is the exact failure mode
    this whole branch is fixing.
  - Fix: after building `instant`, verify the round trip — compare the
    constructed date's UTC year/month/day/hours/minutes/seconds against the
    parsed components and return `value` unchanged on any mismatch. That also
    subsumes the existing `Number.isNaN` check.
  - **Resolution: Fixed.** Added the round-trip check in `normalizeTimestamp`,
    and bounded the zone's hours/minutes in `TIMESTAMP_TEXT` — an offset is
    applied as a plain millisecond shift, so it is the one field the round trip
    cannot catch. All six malformed inputs above now return unchanged; covered
    by a new case in `server/test/shared-time.test.ts`.

- **[LOW] Redundant `as string` casts in the new pg-store test** — `server/test/message-store-pg.test.ts:406-415`
  - `messageRow` takes `Partial<StoredMessage>`, whose `createdAt` is already
    `string` and whose `readAt`/`deletedAt` are `string | null`. The five
    `as string` casts assert nothing the compiler was not going to infer.
  - Why it matters: a cast in a test reads as "the type system disagreed with
    me here", which invites the next reader to look for a shape mismatch that
    does not exist. Casts should be load-bearing or absent.
  - Fix: delete the five `as string` suffixes; the test typechecks without
    them.
  - **Resolution: Fixed.** Casts removed; `npm run typecheck` still clean.

- **[LOW] `normalizeEntryTimestamps` is exported from `messageHistory` only so `chatDb` can borrow it** — `mobile/src/messaging/messageHistory.ts:28`, consumed at `mobile/src/storage/chatDb.ts:4`
  - `messageHistory`'s stated remit is "pure transforms over the per-peer
    message history" whose defining property is returning the same object when
    nothing changed. The entry-shape normaliser fits that description, but it
    is not a history transform — it is a field-level coercion that the storage
    layer now depends on, which points `storage → messaging` for a reason
    unrelated to the history.
  - Why it matters: mild, and there is no import cycle (`messageHistory` pulls
    in only `messageIdentity` and `shared/time`), but the next person adding a
    normalisation concern has no obvious home for it and will either widen
    `messageHistory` further or duplicate the helper.
  - Fix: move `TIMESTAMP_FIELDS` + `normalizeEntryTimestamps` into a small
    `mobile/src/messaging/entryTimestamps.ts` and have both `messageHistory`
    and `chatDb` import from it. It cannot live in `shared/` because it is
    typed against the mobile-only `ChatMessage`.
  - **Resolution: Deferred.** The coupling is real but the fix is a pure file
    move with no behavioural content, and it would touch two modules plus their
    suites for a Low finding at the end of the pass. There is no import cycle
    and no correctness risk in leaving it; worth folding into the next change
    that touches either module.

### Nit

- **[NIT] Chained ternary in the comparator's unknown-value branch** — `server/src/domain/callTimeline.ts:83`
  - `return aKnown === bKnown ? 0 : aKnown ? -1 : 1;` packs three outcomes
    into one line. It is correct and ESLint is happy, but the surrounding file
    consistently spells branches out (see the `isBefore` computation at
    `:152-157`).
  - Fix: split into `if (aKnown === bKnown) return 0;` followed by
    `return aKnown ? -1 : 1;`.
  - **Resolution: Fixed.** Split into a guarded block matching the file's style.

## Fix pass summary

3 of 4 findings fixed, 1 deferred. By severity: Low 2 fixed / 1 deferred,
Nit 1 fixed. No Critical, High or Medium findings were raised. After the fixes:
server typecheck clean, server lint clean, the three touched server suites
40/40, and the affected mobile suites 198/198.

## Out of scope (pre-existing, not graded)

- `server/test/message-store.test.ts:157` and its `searchMessages` sibling
  declare a nested `test()` inside a parent test body without awaiting it, so
  both are reported as `cancelledByParent` (2 failed, 2 cancelled). Verified
  identical at the merge base via a disposable worktree: 28 tests / 24 pass /
  2 fail / 2 cancelled both before and after this diff.
- `server/test/cache-integration.test.ts:166` has the same nested-`test()`
  defect and additionally hangs the file, which is why the full-suite run here
  excludes it. Also reproduced unchanged at the merge base.
- `mobile/src/components/chat/ChatConversationPresentation.tsx` still parses
  timestamps with bare `new Date(...)` in five places (`:242`, `:292`, `:310`,
  `:328`, `:329`). That is deliberate and correct under this design — entries
  reach the screen only via `dedupeAndSort` or `sanitizeSnapshot`, both of
  which now canonicalise — but it does mean the screen depends on an invariant
  it does not enforce itself.
