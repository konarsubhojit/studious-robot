-- One-off cleanup: multiple device rows can end up sharing the same live
-- push token (e.g. an old bug, or a race between concurrent registrations).
-- A token can only legitimately be delivered to one device, so keep only the
-- row with the most recent `updated_at` for each duplicated non-null token and
-- clear the token from the others rather than deleting the device record
-- outright (the row may still be a live device that simply needs to
-- re-register). This must run before the unique index below, or its creation
-- would fail on existing duplicates.
WITH ranked AS (
	SELECT
		"device_id",
		"push_token",
		row_number() OVER (
			PARTITION BY "push_token"
			ORDER BY "updated_at" DESC, "device_id" DESC
		) AS rn
	FROM "devices"
	WHERE "push_token" IS NOT NULL
)
UPDATE "devices"
SET "push_token" = NULL, "push_provider" = NULL
WHERE "device_id" IN (SELECT "device_id" FROM ranked WHERE rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_devices_push_token_unique" ON "devices" USING btree ("push_token") WHERE "devices"."push_token" is not null;