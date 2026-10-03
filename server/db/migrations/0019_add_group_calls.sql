CREATE TABLE "group_call_participants" (
	"call_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_call_participants_call_id_user_id_pk" PRIMARY KEY("call_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_calls" (
	"call_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"initiator_id" text NOT NULL,
	"media_type" text DEFAULT 'video' NOT NULL,
	"status" text NOT NULL,
	"ring_timeout_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "group_call_participants" ADD CONSTRAINT "group_call_participants_call_id_group_calls_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."group_calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_calls" ADD CONSTRAINT "group_calls_conversation_id_group_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."group_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_group_call_participant_user" ON "group_call_participants" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_group_calls_conversation" ON "group_calls" USING btree ("conversation_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_group_calls_retention" ON "group_calls" USING btree ("status","updated_at");