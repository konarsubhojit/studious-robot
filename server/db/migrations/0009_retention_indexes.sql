-- Indexes for the retention sweep (`src/lib/retention.ts`) and for bounded boot
-- hydration.
--
-- `calls`, `call_events` and `audit_log` are append-only and were never deleted
-- from, so both storage and startup grew with history: boot hydration read the
-- whole `calls` table before the process could serve a request. The sweep's
-- predicates cannot use the existing indexes — `idx_calls_caller_updated` /
-- `idx_calls_callee_updated` lead with a participant the sweep does not have,
-- and `idx_audit_actor` / `idx_audit_target` lead with a nullable column.
--
-- `call_events` needs no index of its own: its FK to `calls` is ON DELETE
-- CASCADE, so pruning the parent removes the timeline in the same statement.
CREATE INDEX "idx_audit_ts" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "idx_calls_updated_at" ON "calls" USING btree ("updated_at" desc,"call_id" desc);
