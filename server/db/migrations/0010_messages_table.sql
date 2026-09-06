-- Durable chat history, replacing the MongoDB `messages` collection.
--
-- `pg_trgm` must exist before `idx_messages_body_trgm`: search is a literal,
-- case-insensitive *substring* match (the semantics the memory store implements
-- and the API has always had), and a btree cannot serve an unanchored
-- `LIKE '%term%'`. A trigram GIN index can. `tsvector` was considered and
-- rejected — it matches word stems, which would have quietly changed what the
-- endpoint returns and made the two store backends disagree.
--
-- CREATE EXTENSION needs privileges the runtime role may not have; run this
-- migration with the direct/owner connection (DATABASE_URL_DIRECT), as
-- drizzle.config.ts already requires.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "messages" (
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"body" text NOT NULL,
	"type" text NOT NULL,
	"attachment" jsonb,
	"reply_to" text,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivered_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"read_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_conversation_id_message_id_pk" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_created" ON "messages" USING btree ("conversation_id","created_at" desc,"message_id" desc);--> statement-breakpoint
CREATE INDEX "idx_messages_sender_created" ON "messages" USING btree ("sender_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_messages_recipient_created" ON "messages" USING btree ("recipient_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_messages_unread" ON "messages" USING btree ("recipient_id","conversation_id") WHERE "messages"."read_at" is null;--> statement-breakpoint
CREATE INDEX "idx_messages_body_trgm" ON "messages" USING gin (lower("body") gin_trgm_ops);