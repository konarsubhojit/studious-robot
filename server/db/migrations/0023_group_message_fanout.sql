ALTER TABLE "group_messages" ADD COLUMN "delivered_to" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "group_messages" ADD COLUMN "read_by" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE "group_message_changes" (
  "change_id" bigint PRIMARY KEY DEFAULT nextval('message_changes_change_id_seq') NOT NULL,
  "conversation_id" uuid NOT NULL,
  "message_id" text NOT NULL,
  "change_type" text NOT NULL,
  "changed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "group_message_changes_conversation_id_message_id_group_messages_conversation_id_message_id_fk"
    FOREIGN KEY ("conversation_id", "message_id")
    REFERENCES "group_messages" ("conversation_id", "message_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "idx_group_message_changes_cursor" ON "group_message_changes" ("conversation_id", "changed_at", "change_id");
--> statement-breakpoint
CREATE INDEX "idx_group_messages_body_fts" ON "group_messages" USING gin (to_tsvector('simple', "body")) WHERE "deleted_at" IS NULL;
--> statement-breakpoint
INSERT INTO "group_message_changes" ("conversation_id", "message_id", "change_type", "changed_at")
SELECT "conversation_id", "message_id",
  CASE WHEN "deleted_at" IS NULL THEN 'new' ELSE 'deleted' END,
  COALESCE("deleted_at", "created_at")
FROM "group_messages"
ORDER BY COALESCE("deleted_at", "created_at"), "message_id";
