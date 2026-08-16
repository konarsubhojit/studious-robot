ALTER TABLE "users" ADD COLUMN "auth_uid" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_provider" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_uid_unique" UNIQUE("auth_uid");