# Grumpy Code Review — copilot/optimize-cosmos-db-postgres-queries vs master

_Reviewed 583f6b4d8d374f22bdcea4e86319adb3f754d996..48f9e7b, 13 files changed._

## Summary

Not mergeable yet. The new routing index removes the server-side cross-partition query, but then replaces it with an N+1 pattern that can issue 201 Mongo commands for one request. That misses the stated single-partition lookup goal and can be slower than the query it replaces.

## Findings

### Critical

None.

### High

- **[HIGH] The optimized conversation list is still an N+1 query** — `server/src/messageStore/mongoStore.ts:186`
  - After one `conversation_index` read, the implementation performs two message queries for every conversation: one latest-message query and one unread-message query. At the configured 100-conversation maximum this is 201 database commands. The four-conversation batching still requires at least 25 network rounds, so a 13 ms RTT alone contributes roughly 325 ms before Cosmos processing.
  - This directly misses the requested single-partition conversation-list lookup and can consume more RU than the original fan-out.
  - Store `lastMessage` and `unreadCount` in each user-partitioned conversation-index row. Update those rows on message save/read/delivery/reaction/delete so `listConversations` is one projected, sorted, limited query.
  - **Resolution: Fixed.** Conversation-index rows now materialize the summary and `listConversations` performs exactly one bounded query.

### Medium

- **[MEDIUM] A bad routing row can expose a conversation to the wrong user** — `server/src/messageStore/mongoStore.ts:202`
  - The optimized path trusts `conversation_index.userId` and returns the latest message without checking that its sender or recipient equals the requesting user. The legacy path uses `summariseConversations`, which explicitly drops non-participant messages.
  - A malformed backfill row or operational data repair mistake could return another conversation's latest message.
  - Preserve the existing authorization invariant by dropping and logging any indexed result whose latest message does not include `userId`.
  - **Resolution: Fixed.** The indexed path filters out rows whose latest message does not include the requesting user, with regression coverage.

### Low

None.

### Nit

None.

## Out of scope (pre-existing, not graded)

- The legacy fallback and `searchMessages` still perform unbounded cross-partition reads. The fallback is intentionally retained behind the disabled-by-default migration flag; search optimization was not changed by this diff.
- The full server suite passes (490 passed, 1 skipped), as do lint, typecheck, and Drizzle schema checks.

## Resolution summary

Fixed one High and one Medium finding; none deferred.
