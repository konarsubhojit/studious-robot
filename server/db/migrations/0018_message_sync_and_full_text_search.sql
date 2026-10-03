CREATE TABLE "message_changes" (
	"change_id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"change_type" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"message" jsonb NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_messages_body_trgm";--> statement-breakpoint
DROP INDEX "idx_messages_sender_body_trgm";--> statement-breakpoint
DROP INDEX "idx_messages_recipient_body_trgm";--> statement-breakpoint
ALTER TABLE "message_changes" ADD CONSTRAINT "message_changes_conversation_id_message_id_messages_conversation_id_message_id_fk" FOREIGN KEY ("conversation_id","message_id") REFERENCES "public"."messages"("conversation_id","message_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_message_changes_sender_cursor" ON "message_changes" USING btree ("sender_id","changed_at","change_id");--> statement-breakpoint
CREATE INDEX "idx_message_changes_recipient_cursor" ON "message_changes" USING btree ("recipient_id","changed_at","change_id");--> statement-breakpoint
INSERT INTO "message_changes" ("conversation_id","message_id","sender_id","recipient_id","change_type","changed_at","message")
SELECT
	"conversation_id",
	"message_id",
	"sender_id",
	"recipient_id",
	CASE WHEN "deleted_at" IS NULL THEN 'new' ELSE 'deleted' END,
	COALESCE("deleted_at", "created_at"),
	jsonb_build_object(
		'messageId', "message_id",
		'conversationId', "conversation_id",
		'senderId', "sender_id",
		'recipientId', "recipient_id",
		'body', "body",
		'type', "type",
		'attachment', "attachment",
		'replyTo', "reply_to",
		'reactions', "reactions",
		'deletedAt', CASE WHEN "deleted_at" IS NULL THEN NULL ELSE to_char("deleted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
		'createdAt', to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
		'deliveredTo', "delivered_to",
		'readAt', CASE WHEN "read_at" IS NULL THEN NULL ELSE to_char("read_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
	)
FROM "messages"
ORDER BY COALESCE("deleted_at", "created_at"), "message_id";--> statement-breakpoint
CREATE INDEX "idx_messages_body_fts" ON "messages" USING gin (to_tsvector('simple', "body")) WHERE "messages"."deleted_at" is null;