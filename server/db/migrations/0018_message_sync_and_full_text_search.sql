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
CREATE INDEX "idx_messages_body_fts" ON "messages" USING gin (to_tsvector('simple', "body")) WHERE "messages"."deleted_at" is null;