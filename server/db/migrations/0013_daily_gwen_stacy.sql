-- Conversation-list projection over `messages`, which stays the source of
-- truth.  The projection stores only the stable addressing/sort fields and a
-- pointer to the latest message: previews are joined from `messages`, so later
-- tombstones, reactions and delivery receipts are observed without rewriting
-- this row.
--
-- `participant_a` / `participant_b` deliberately preserve
-- `deriveConversationId`'s sorted participant invariant. That makes the unread
-- counters addressable by pure string comparison in application code ("am I A
-- or B?") instead of another lookup or role column.
CREATE TABLE "conversations" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"participant_a" text NOT NULL,
	"participant_b" text NOT NULL,
	"last_message_id" text NOT NULL,
	"last_created_at" timestamp with time zone NOT NULL,
	"unread_a" integer DEFAULT 0 NOT NULL,
	"unread_b" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- These indexes carry the outer `listConversations` sort order behind each
-- participant column. A page for either side of the conversation is therefore
-- an index scan in `(last_created_at DESC, last_message_id DESC)` order rather
-- than a sort of the user's entire projected inbox.
--
-- They are intentionally not `CREATE INDEX CONCURRENTLY`: Drizzle's migrator
-- runs migrations transactionally, and Postgres rejects concurrent index builds
-- inside a transaction block (same operational constraint as 0012).
CREATE INDEX "idx_conversations_a" ON "conversations" USING btree ("participant_a","last_created_at" desc,"last_message_id" desc);--> statement-breakpoint
CREATE INDEX "idx_conversations_b" ON "conversations" USING btree ("participant_b","last_created_at" desc,"last_message_id" desc);--> statement-breakpoint
-- Backfill the whole projection in one pass from `messages`. This is the
-- expensive query; on Neon, pin the compute size while it runs so autoscaling
-- and scale-to-zero noise do not stretch the migration.
--
-- Participants are sorted from the latest row's sender/recipient values rather
-- than parsed from `conversation_id`: the id format uses ':' today, but a user
-- id could contain that separator, while each message row already stores both
-- participants losslessly.
-- conversations-backfill:start
INSERT INTO "conversations" (
	"conversation_id",
	"participant_a",
	"participant_b",
	"last_message_id",
	"last_created_at",
	"unread_a",
	"unread_b"
)
WITH "last_messages" AS (
	SELECT DISTINCT ON ("conversation_id")
		"conversation_id",
		"message_id",
		LEAST("sender_id", "recipient_id") AS "participant_a",
		GREATEST("sender_id", "recipient_id") AS "participant_b",
		"created_at"
	FROM "messages"
	ORDER BY "conversation_id", "created_at" DESC, "message_id" DESC
),
"unread_counts" AS (
	SELECT
		"conversation_id",
		"recipient_id",
		count(*)::int AS "unread_count"
	FROM "messages"
	WHERE "read_at" IS NULL
	GROUP BY "conversation_id", "recipient_id"
)
SELECT
	"last_messages"."conversation_id",
	"last_messages"."participant_a",
	"last_messages"."participant_b",
	"last_messages"."message_id",
	"last_messages"."created_at",
	COALESCE(
		SUM("unread_counts"."unread_count")
			FILTER (WHERE "unread_counts"."recipient_id" = "last_messages"."participant_a"),
		0
	)::int AS "unread_a",
	COALESCE(
		SUM("unread_counts"."unread_count")
			FILTER (WHERE "unread_counts"."recipient_id" = "last_messages"."participant_b"),
		0
	)::int AS "unread_b"
FROM "last_messages"
LEFT JOIN "unread_counts"
	ON "unread_counts"."conversation_id" = "last_messages"."conversation_id"
GROUP BY
	"last_messages"."conversation_id",
	"last_messages"."participant_a",
	"last_messages"."participant_b",
	"last_messages"."message_id",
	"last_messages"."created_at";
-- conversations-backfill:end