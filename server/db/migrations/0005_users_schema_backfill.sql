ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_uid" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_provider" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "verification_hash";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "verification_salt";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_auth_uid_unique" ON "users" USING btree ("auth_uid") WHERE "users"."auth_uid" is not null;
