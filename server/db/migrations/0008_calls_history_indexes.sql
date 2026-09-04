-- `GET /calls` reads this table as `(caller_id = $1 OR callee_id = $1)` ordered
-- by `updated_at DESC, created_at DESC, call_id DESC`. The replaced indexes
-- were keyed on `created_at`, so they could serve the participant predicate but
-- never the ordering, and every page sorted the user's entire call history
-- before discarding all but one page of it.
--
-- The new indexes are created before the old ones are dropped so the query is
-- never left unindexed, and every statement is idempotent so a re-run (or a
-- partially applied migration) converges rather than failing.
CREATE INDEX IF NOT EXISTS "idx_calls_caller_updated" ON "calls" USING btree ("caller_id","updated_at" desc,"created_at" desc,"call_id" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_calls_callee_updated" ON "calls" USING btree ("callee_id","updated_at" desc,"created_at" desc,"call_id" desc);--> statement-breakpoint
DROP INDEX IF EXISTS "idx_calls_caller_created";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_calls_callee_created";
