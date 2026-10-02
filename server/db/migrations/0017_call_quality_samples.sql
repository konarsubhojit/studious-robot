CREATE TABLE "call_quality_samples" (
	"sample_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"rtt_ms" real NOT NULL,
	"jitter_ms" real NOT NULL,
	"packet_loss_percent" real NOT NULL,
	"bitrate_bps" real NOT NULL,
	"codec" text NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_quality_samples" ADD CONSTRAINT "call_quality_samples_call_id_calls_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_call_quality_call_sampled" ON "call_quality_samples" USING btree ("call_id","sampled_at" desc);--> statement-breakpoint
CREATE INDEX "idx_call_quality_sampled" ON "call_quality_samples" USING btree ("sampled_at");