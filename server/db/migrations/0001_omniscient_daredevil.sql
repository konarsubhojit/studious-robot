CREATE TABLE "users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"verification_hash" text,
	"verification_salt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone
);
