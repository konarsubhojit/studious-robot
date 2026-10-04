ALTER TABLE "group_messages" ADD COLUMN "client_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "client_message_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_group_messages_sender_client_message" ON "group_messages" USING btree ("sender_id","client_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_messages_sender_client_message" ON "messages" USING btree ("sender_id","client_message_id");