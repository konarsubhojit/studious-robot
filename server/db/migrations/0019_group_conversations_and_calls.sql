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
	"state_version" integer DEFAULT 1 NOT NULL,
	"ring_timeout_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_conversations" (
	"conversation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"creator_id" text NOT NULL,
	"membership_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_messages" (
	"conversation_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"body" text NOT NULL,
	"type" text NOT NULL,
	"attachment" jsonb,
	"reply_to" text,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "group_messages_conversation_id_message_id_pk" PRIMARY KEY("conversation_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "group_call_participants" ADD CONSTRAINT "group_call_participants_call_id_group_calls_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."group_calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_calls" ADD CONSTRAINT "group_calls_conversation_id_group_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."group_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_conversation_members" ADD CONSTRAINT "group_conversation_members_conversation_id_group_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."group_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_messages" ADD CONSTRAINT "group_messages_conversation_id_group_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."group_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_group_call_participant_user" ON "group_call_participants" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_group_calls_conversation" ON "group_calls" USING btree ("conversation_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "idx_group_calls_retention" ON "group_calls" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_group_calls_ringing_timeout" ON "group_calls" USING btree ("ring_timeout_at") WHERE "group_calls"."status" = 'ringing';--> statement-breakpoint
CREATE INDEX "idx_group_members_user" ON "group_conversation_members" USING btree ("user_id","conversation_id");--> statement-breakpoint
CREATE INDEX "idx_group_members_active" ON "group_conversation_members" USING btree ("conversation_id","left_at");--> statement-breakpoint
CREATE INDEX "idx_group_conversations_updated" ON "group_conversations" USING btree ("updated_at" desc);--> statement-breakpoint
CREATE INDEX "idx_group_messages_created" ON "group_messages" USING btree ("conversation_id","created_at" desc,"message_id" desc);