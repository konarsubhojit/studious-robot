-- btree_gin lets a GIN index carry plain scalar columns alongside the trigram
-- body index. `searchMessages` filters on participation AND an unanchored
-- `lower(body) LIKE '%term%'`; today those are two different index types, so
-- the planner bitmap-ANDs a GIN over every user's messages against a btree.
-- Folding the participant columns into the GIN makes the search term and the
-- participant a single index probe.
--
-- CREATE EXTENSION needs owner privileges; run with DATABASE_URL_DIRECT, as
-- drizzle.config.ts already requires (see 0010).
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
CREATE INDEX "idx_messages_sender_body_trgm" ON "messages" USING gin ("sender_id",lower("body") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_recipient_body_trgm" ON "messages" USING gin ("recipient_id",lower("body") gin_trgm_ops);