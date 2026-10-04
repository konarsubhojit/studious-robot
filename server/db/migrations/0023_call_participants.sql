CREATE TABLE "call_participants" (
	"call_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text NOT NULL,
	"ring_timeout_at" timestamp with time zone,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"device_id" text,
	CONSTRAINT "call_participants_call_id_user_id_pk" PRIMARY KEY("call_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "call_participants" ADD CONSTRAINT "call_participants_call_id_calls_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_call_participants_user" ON "call_participants" USING btree ("user_id","call_id");