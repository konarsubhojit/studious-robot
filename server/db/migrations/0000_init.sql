CREATE TABLE "calls" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"caller_id" text NOT NULL,
	"callee_id" text NOT NULL,
	"status" text NOT NULL,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ring_timeout_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "call_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text,
	"push_provider" text,
	"push_token" text,
	"last_registered_at" timestamp with time zone,
	"last_unregistered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"actor" text,
	"target" text,
	"outcome" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" text NOT NULL,
	"blockee_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blockee_id_pk" PRIMARY KEY("blocker_id","blockee_id")
);
--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_calls_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_calls_caller_created" ON "calls" USING btree ("caller_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_calls_callee_created" ON "calls" USING btree ("callee_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_calls_status" ON "calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_call_events_call" ON "call_events" USING btree ("call_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_devices_user" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "audit_log" USING btree ("actor","ts");--> statement-breakpoint
CREATE INDEX "idx_audit_target" ON "audit_log" USING btree ("target","ts");