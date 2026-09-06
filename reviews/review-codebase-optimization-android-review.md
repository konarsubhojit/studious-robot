# Grumpy Code Review — copilot/review-codebase-optimization vs origin/master

_Reviewed `ed7cbcec`..`cd77b24`, 104 files changed (+6630 / −4095). This pass
covers the Android defect fixes and the `callTimeline` durability work; the
earlier Postgres-consolidation half of the branch was reviewed separately in
`review-codebase-optimization-review.md` and its findings are closed._

## Summary

Mergeable. The branch does what it says: seven genuine user-visible Android
defects are fixed with a regression test each, and the last "memory bound
mistaken for a history horizon" read path on the server is now durable. Test
count went 2114 → 2159 (mobile) and 529 → 541 (server), all green, both lint
and typecheck clean.

The worst things in it were found and fixed **during** this review rather than
after it, and they were all mine: a stack-overflow-by-spread on wire data, a
`chatDb` guard that still lost a write landing mid-read, a load-after-save that
returned the pre-save snapshot, and an acknowledgement `UPDATE` that bumped the
very column the call log is ordered by. All four now have tests that were
empirically confirmed to fail against the defective version. What remains open
is not defects but two deliberate deferrals and one heuristic that wants a
device.

## Findings

### Critical

None open.

_Closed during this pass:_

- **[CRITICAL] `chatDb` discarded the entire local store** — `mobile/src/storage/chatDb.ts`
  - `loadChatSnapshot` began `if (cache) return cache;` while `saveChatSnapshot`
    seeded `cache` from `emptySnapshot()`. `persistOutbox` is reachable from
    `sendMessage` before the first disk read resolves, so the load
    short-circuited on that empty object and returned it — dropping every
    persisted conversation, message and draft, then writing the empty result
    back over the file.
  - Fixed with `loadPromise` / `hasLoaded` / `preloadWrites`. Two follow-on
    defects in that fix were also caught here: the guard was `!loadPromise`
    ("has a read started") rather than `!hasLoaded` ("has the file been folded
    in"), which still lost a write landing *during* the read; and returning the
    promise's value made a load-after-save return the pre-save snapshot,
    contradicting the module's own documented contract. Both now covered.

### High

None open.

_Closed during this pass:_

- **[HIGH] Live messages erased by a history refetch** — `mobile/src/messaging/messageHistory.ts`
  - `mergeHistoryPage` returned the server page verbatim, keeping only
    `pending`/`failed` entries. `useChatSync` refetches page 1 on every
    conversation open, so a message arriving over the socket during that round
    trip vanished from `messagesByPeer` while `conversations` had already
    counted it — exactly the reported "badge says 1, screen shows nothing".
  - Fixed by treating the server as authoritative only over the window the page
    actually reports on.
- **[HIGH] `Math.max(...times)` on wire data** — `mobile/src/messaging/messageHistory.ts`
  - The first cut of that fix spread an array straight off the network into
    `Math.min`/`Math.max`. A large page blows the call stack. Replaced with a
    single-pass `pageWindow()`; the `as number[]` cast that was papering over
    the nullable element type went with it.
- **[HIGH] Acknowledging a missed call reordered the call log** — `server/src/domain/callTimeline.ts:195`
  - My new `markMissedCallsRead` UPDATE set `updatedAt` alongside `missedReadAt`.
    `GET /calls` orders by `updated_at DESC`, so merely opening a conversation
    would have jumped that call to the top of the user's call history. The old
    fire-and-forget `persistCallRecord` wrote the record's *unchanged*
    `updatedAt`, so this was a regression introduced by the durability work, not
    pre-existing.
  - Fixed to set `missedReadAt` only. Acknowledging is not a state transition.
    `test/call-timeline.test.ts` test 12 was confirmed to fail against the
    bumped version.

### Medium

- **[MEDIUM] The composer stale-echo guard is heuristic** — `mobile/src/components/chat/ChatConversationPresentation.tsx:1857`
  - Value equality is the only signal available for distinguishing "the native
    input is echoing the text I just sent" from "the user retyped that exact
    word". The guard drops exactly one event equal to `sentEchoRef.current`
    immediately after a send, which bounds the blast radius to a single
    keystroke in a narrow window, and unit tests cover both branches.
  - Why it matters: it is still a guess about native `TextInput` timing, and
    the reported symptom (tap-tap-tap) is precisely the timing-sensitive case.
  - Suggested fix: none in code — this needs one manual pass on a physical
    device typing and sending rapidly, including retyping a just-sent word. If
    it misbehaves, the fallback is an uncontrolled input driven by a ref, which
    removes the race entirely at the cost of the controlled-input invariant.

_Closed during this pass:_

- **[MEDIUM] Chat list drifted from the open conversation** — `withOutgoingMessage`
  added and a single `optimistic` object now shared between `messagesByPeer` and
  `conversations` so the two views cannot disagree. A duplicate
  `buildOptimisticMessage(outgoing)` call in `useMessaging` was removed.
- **[MEDIUM] `saveChatSnapshot` re-pruned every conversation on every write** —
  including `persistOutbox`'s outbox-only write on each ack, i.e. a ~20k-entry
  sort on the JS thread at the 100×200 ceiling. Now prunes only supplied tables.
- **[MEDIUM] Status bar depended on `zIndex` for paint order** —
  `CallsScreen`/`ChatListScreen` rendered the toast before its siblings and
  relied on `zIndex: 1`. Now rendered last, matching `SettingsScreen`'s
  `toastLayer`, so it paints on top regardless.
- **[MEDIUM] Threading `status` re-rendered the whole chat list** —
  `TabShell`'s `renderChatList` gained `status` as a dependency, and that slot is
  rewritten throughout a call ("Calling bob…", "Connected") with none of it
  shown by the bar. Now narrowed through an exported `alertStatus()` and
  memoised on message + severity, so info churn no longer reaches the list.

### Low

- **[LOW] `MAX_ACTIVITY_CALLS` caps the unread badge at 500** — `server/src/domain/callTimeline.ts`
  - A user with more than 500 unacknowledged missed calls from all peers
    combined will see an undercounted badge.
  - Why it matters: barely. It is a badge, and 500 unacknowledged missed calls
    is a pathological account.
  - Suggested fix: leave it. If it ever matters, replace the second query with
    `count(*) … GROUP BY caller_id`, which is the right shape anyway — it was
    avoided here only because the offline test harness cannot model aggregates.

- **[LOW] Two bounded queries where one aggregate would do** — `server/src/domain/callTimeline.ts`
  - `readCallActivityByPeer` issues a "newest calls" query and an "unread
    missed" query and folds them by `callId`, rather than one
    `DISTINCT ON (peer) … + count(*)` statement.
  - Why it matters: one extra round trip per chat-list load. The two queries
    genuinely have different retention rules (newest-N vs all-unacknowledged),
    so collapsing them is not free.
  - Suggested fix: leave until the chat list shows up in query timings.

### Nit

- **[NIT] `test/fakeCallsDb.ts` predicate compiler is string-matching Drizzle internals** —
  it keys on the literal SQL fragments `'is null'` and `'<'`. That is inherent to
  standing in for Drizzle without a database, and it throws loudly on anything it
  does not model rather than silently matching everything, which is the right
  failure mode. Noted so nobody mistakes it for a supported API.

## Out of scope (pre-existing, not graded)

- The mobile Jest run still emits "a worker process has failed to exit
  gracefully". Confirmed previously to be an RN Animated mock artifact from
  `Skeleton`/`RingingAvatar`'s `Animated.loop`, not a product leak; `--forceExit`
  is the standing workaround.
- A user who registered *before* the new username gate, with a name the server
  rejects, still has it on disk and is still admitted on cold start. Auto-
  unregistering on a 409 was considered and rejected: a transient server fault
  would log the whole fleet out. The refusal is at least now surfaced.
- `parallel_validation` / CodeQL is not available in this environment, so no
  static security scan was run against the diff. The changed areas — local
  persistence, auth gating, a new SQL `UPDATE` — are worth a CodeQL pass in CI.
