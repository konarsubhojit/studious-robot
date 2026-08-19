ALTER TABLE "calls" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "missed_read_at" timestamp with time zone;