# Grumpy Code Review — copilot/mobile-add-group-support vs master

_Reviewed ab157a3..cf2d24e, 47 files changed (2,318 insertions)._

## Summary
Mergeable after fixes, but not as it stands. The group work itself is carefully
contract-driven — every mock path is validated against the frozen shared
schemas, membership is re-checked on every send/typing/read path, and the
durable outbox is reused instead of forked. The worst thing in it is collateral
damage to *direct* messaging: the new `conversationId` guards in
`handleMessageRead` / `handleTypingEvent` silently drop legitimate 1:1 read
receipts and typing indicators whenever the local conversation row does not yet
carry a `conversationId`, which is exactly the state a brand-new conversation is
in. Second worst: one malformed group row in `GET /conversations` throws away
the entire conversation refresh, direct rows included.

## Findings

### Critical
None.

### High

- **[HIGH] Direct read receipts and typing indicators are dropped for conversations without a cached `conversationId`** — `mobile/src/hooks/useMessaging.ts:1224`, `mobile/src/hooks/useMessaging.ts:1248`
  - Both handlers end their group branch with a direct-path guard:
    `if (conversationId && conversationId !== conversationIdForPeer(conversationsRef.current, readerId)) return;`.
    `conversationIdForPeer` returns `null` when the row has no `conversationId`
    (`mobile/src/messaging/conversations.ts:37-42`), and the optimistic row
    created by the first outgoing message stores `message.conversationId ?? undefined`
    (`mobile/src/messaging/conversations.ts:62-67`) — which is `null` until a
    `GET /conversations` refetch lands. The server *always* sends
    `conversationId` on both events (`server/src/routes/messages.routes.ts:661`,
    `server/src/signaling/messageHandlers/index.ts:510-514`), so `null !== 'a:b'`
    and the event is discarded.
  - Effect: the first message you ever send to someone never flips to "Read"
    (the server emits `message.read` once, when `updated > 0`), and a typing
    indicator from a peer you have no row for yet never appears. This is a
    regression in the 1:1 path the diff was supposed to leave alone; no existing
    test covers it because every direct test calls these handlers without a
    `conversationId`.
  - Fix: only reject on a *contradiction*, not on an absence — resolve the known
    id first and skip the guard when it is `null`:
    `const known = conversationIdForPeer(...); if (conversationId && known && conversationId !== known) return;`.
    The group case is already fully handled by the `row.group` lookup directly
    above, so nothing is lost.

### Medium

- **[MEDIUM] One bad group record discards the whole conversation refresh** — `mobile/src/hooks/useMessaging.ts:360`, `mobile/src/chat/groupTransportAdapter.ts:18-23`
  - `parseGroupList` throws on the first record that fails
    `SERVER_EVENT_SCHEMAS[CONVERSATION_UPDATED]`, and the call sits inside
    `fetchConversations`'s `try`, *before* `setConversations`. A single group
    with, say, a whitespace-only `name` (the schema requires `min: 1` after
    trim — `shared/signaling/schemas.ts:162-171`) therefore aborts the refresh
    for the user's **direct** conversations too; the list silently goes stale
    with nothing but a `logWarn`.
  - Fix: make `parseGroupList` skip-and-log invalid records (`safeParse` per
    record) rather than throwing, or parse groups outside the direct-conversation
    update path so a group failure degrades to "no group rows this round".

- **[MEDIUM] `groupActions` ships preview-simulation methods to every consumer** — `mobile/src/hooks/useMessaging.ts:598-614`, `mobile/src/chat/ChatProvider.tsx:33`
  - `previewActivity(id, memberId, 'typing' | 'read' | 'message')` fabricates
    inbound messages, typing state and read receipts. It lives in the same
    object as `create`/`members`/`rename`/`leave` and is exposed through
    `ChatContextValue`, so every screen that needs to rename a group also gets a
    handle that can inject fake peer messages into the timeline (ISP; SRP for
    the hook, which now owns direct messaging, group messaging, the local mock
    and the simulation harness in one 1,400-line file).
  - Fix: move the simulation surface into its own object (e.g.
    `groupPreviewActions`) produced only when `groupTransport !== 'live'`, so
    the live build cannot reach it at all and the production group API stays
    four methods wide.

- **[MEDIUM] Received group messages bypass the seen-registry and in-app notification path** — `mobile/src/hooks/useMessaging.ts:1134-1150`
  - `handleGroupMessageReceived` returns before `markMessageSeen(...)` and
    `displayMessageReceivedInApp(...)`, both of which the direct path runs
    (`mobile/src/hooks/useMessaging.ts:1189-1196`). A group message that arrives
    while the app is foregrounded but the thread is closed produces no
    notification at all, and nothing is recorded in the dedupe registry that the
    push path consults.
  - Fix: call `markMessageSeen(message.messageId)` on the accepted-group branch
    and route non-active-thread group messages through
    `displayMessageReceivedInApp`, or state explicitly in
    `mobile/README.md` that group notifications are deliberately out of scope
    until the server fans out group pushes.

- **[MEDIUM] `leave` reports failure after the departure has already happened** — `mobile/src/hooks/useMessaging.ts:582-600`
  - The final `await flushChatDb(scope)` is unguarded, unlike every other flush
    in this hook (`commit` restores the previous list, `live` degrades to
    `updateStatus`). If the write fails, `leave` rejects, `GroupConversationScreen`'s
    `run` shows "…" as an error and `onBack()` never runs — even though the user
    *has* left the group and the outbox has been poisoned with
    `lastError: 'Left group'`.
  - Fix: wrap it like `live` does — surface a non-fatal `updateStatus` about the
    cache, and let `leave` resolve.

### Low

- **[LOW] Unthemed fallback text while a group row is resolving** — `mobile/src/components/TabShell.tsx:170`
  - `return <View><Text>Loading group…</Text></View>;` is the only raw,
    unstyled `Text` in the shell. On the dark theme it renders near-black text
    on the dark background. Fix: use the existing themed styles (or the same
    empty-state primitive the other screens use).

- **[LOW] The group composer has no typing idle timer** — `mobile/src/components/GroupConversationScreen.tsx:151-154`
  - The direct composer clears its indicator after `TYPING_IDLE_MS`
    (`mobile/src/components/chat/ChatConversationPresentation.tsx:2194-2203`);
    the group one only emits `false` on blur or send, so a user who stops typing
    with text still in the box keeps every other member's indicator alive until
    the receiver-side safety timeout fires. Fix: reuse the same idle-timer
    pattern.

- **[LOW] `applyGroupSnapshot` — the live membership reducer — lives in `groupMockAdapter.ts`** — `mobile/src/chat/groupMockAdapter.ts:60-72`, `mobile/src/chat/groupTransportAdapter.ts:30`
  - The live transport adapter and the live `conversation.updated` socket
    handler both import their core reducer from a module whose header comment
    says "Local-only behavior". That is actively misleading for the next
    maintainer. Fix: move `applyGroupSnapshot` into `groupTransportAdapter.ts`
    (or a neutral `groupRows.ts`) and let the mock import it.

- **[LOW] `retired` call-id set grows for the lifetime of the account scope** — `mobile/src/chat/useGroupCalls.ts:37`
  - Every superseded `callId` is retained until the scope changes. Bounded in
    practice by calls-per-session, but it is an unbounded-by-design set. Fix:
    cap it (ring buffer / `Map` with an eviction limit) the way
    `server/src/domain/conversationFanout.ts:14` caps its version cache.

### Nit

- **[NIT] `fetchGroupHistory` types `authedFetch` as `Function`** — `mobile/src/messaging/fetchHistory.ts:39`
  - Copied from the existing `fetchHistory` signature, so it is consistent, but
    it propagates an untyped callable into new code. Worth a shared
    `AuthedFetch` alias next time either function is touched.

## Out of scope (pre-existing, not graded)
- `mobile/src/messaging/fetchHistory.ts:22-26` already took `authedFetch: Function`
  and an unused `cachedCount` (`void cachedCount;`) before this branch.
- The mobile Jest run still leaks worker handles ("A worker process has failed
  to exit gracefully"); unrelated to this diff, which is why the suite is run
  with `--forceExit`.

## Tool baseline
`npm run typecheck`, `npm run lint` and `npx jest --ci --forceExit` (159 suites,
2,655 tests) all pass on the branch. One test failure *was* introduced by this
diff and has already been corrected in it:
`__tests__/crashReportingNativeSetup.test.ts` asserted the Gradle bundle-cache
input list literally, and adding `GROUP_TRANSPORT` to
`mobile/android/app/build.gradle:98` broke it; the assertion now checks that the
three Sentry keys are present rather than that they are the only keys.
