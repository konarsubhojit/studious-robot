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

## Re-review findings

### High

- **[HIGH] Concurrent sends can regress the denormalized last message** — `server/src/messageStore/mongoStore.ts:45`
  - Every successful save unconditionally assigns `lastMessage` and `updatedAt`. Two overlapping saves can commit messages in timestamp order but complete their summary writes in reverse order, leaving an older message at the top of both users' conversation lists.
  - This is reachable under normal multi-instance traffic and makes the optimized query return incorrect data.
  - Initialize the row idempotently, increment unread independently, then update the latest-message fields only when the stored `(createdAt, messageId)` ordering is older.
  - **Resolution: Fixed.** Summary rows are initialized idempotently and later messages use a `(createdAt, messageId)` compare-and-set update, while unread increments independently.

- **[HIGH] A transient summary failure leaves unread counts permanently stale** — `server/src/messageStore/mongoStore.ts:292`
  - `markRead` updates message rows first and only repairs the summary when `modifiedCount` is non-zero. If the summary update fails, retrying marks zero message rows and skips the summary forever.
  - The API can therefore keep showing unread messages after they were successfully marked read.
  - Reconcile the summary whenever the conversation index is enabled, regardless of `modifiedCount`.
  - **Resolution: Fixed.** `markRead` now reconciles the summary even when a retry modifies zero message rows.

### Medium

- **[MEDIUM] Live writes can be omitted while the backfill runs** — `deploy/README.md:469`
  - The index is not written while `MONGODB_CONVERSATION_INDEX_READY=false`, but the runbook leaves the server serving writes during the one-time scan. Messages inserted after the cursor passes their location can be absent when reads are enabled.
  - This creates incomplete conversation lists immediately after migration.
  - Add a separate write-enable flag and deployment phase: provision, enable dual writes, backfill, then enable indexed reads.
  - **Resolution: Fixed.** `MONGODB_CONVERSATION_INDEX_WRITES` enables dual writes before backfill, independently of indexed reads, and the runbook documents the two reload phases.

Second pass: fixed two High and one Medium finding; none deferred.

## Final re-review findings

### Critical

None.

### High

- **[HIGH] The live backfill can overwrite newer dual-written summaries** — `server/scripts/backfill-conversation-index.ts:75`
  - The script scans all messages into memory and later writes every summary with an unconditional `$set`. A live send after the cursor has passed a conversation is correctly dual-written, but the older in-memory summary can subsequently replace its `lastMessage`, `updatedAt`, and `unreadCount`.
  - Enabling reads after that race exposes stale conversation ordering and unread state despite following the documented migration sequence.
  - Drain/stop application writers before running this authoritative full backfill, and document restarting with both write and read flags only after it completes.
  - **Resolution: Fixed.** The runbook now requires all message writers to be gracefully drained and stopped for the authoritative backfill and verification window, then restarted only after indexed reads are enabled.

### Medium

None.

### Low

None.

### Nit

None.

## Final re-review validation

The full server suite passes (490 passed, 1 skipped), as do lint, typecheck,
Drizzle schema checks, and `git diff --check`.

Final fix pass: fixed one High finding; none deferred.

## Final gate

Mergeable. Re-reviewed the complete 14-file diff after the migration runbook
fix; no open Critical, High, Medium, Low, or Nit findings remain.
