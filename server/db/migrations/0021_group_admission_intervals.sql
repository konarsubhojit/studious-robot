CREATE TABLE "group_invitations" (
	"invitation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"invitee_id" text NOT NULL,
	"issuer_id" text NOT NULL,
	"membership_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_membership_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"membership_version" integer NOT NULL,
	"event" text NOT NULL,
	"actor_id" text NOT NULL,
	"user_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_conversation_members" DROP CONSTRAINT "group_conversation_members_conversation_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "group_conversation_members" ADD COLUMN "member_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "group_conversation_members" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_conversation_members" ADD COLUMN "departure_actor_id" text;--> statement-breakpoint
ALTER TABLE "group_conversation_members" ADD COLUMN "departure_reason" text;--> statement-breakpoint
ALTER TABLE "group_invitations" ADD CONSTRAINT "group_invitations_conversation_id_group_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."group_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_membership_events" ADD CONSTRAINT "group_membership_events_conversation_id_group_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."group_conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_group_invitations_invitee" ON "group_invitations" USING btree ("invitee_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_group_invitations_pending" ON "group_invitations" USING btree ("conversation_id","invitee_id") WHERE "group_invitations"."accepted_at" is null and "group_invitations"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "idx_group_membership_events_order" ON "group_membership_events" USING btree ("conversation_id","membership_version","created_at","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_group_members_active_unique" ON "group_conversation_members" USING btree ("conversation_id","user_id") WHERE "group_conversation_members"."left_at" is null;