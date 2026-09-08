-- Queued account erasures (right to erasure), see `src/domain/accountDeletion.ts`.
--
-- The row is the queue: the cascade spans Postgres, Redis and R2, so it runs in
-- a background sweep rather than inside the request, and a restart mid-cascade
-- must be able to pick the work back up. It also carries the grace period
-- (`scheduled_for`) during which the request can still be cancelled.
CREATE TABLE "account_deletions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_account_deletions_due" ON "account_deletions" USING btree ("status","scheduled_for");
