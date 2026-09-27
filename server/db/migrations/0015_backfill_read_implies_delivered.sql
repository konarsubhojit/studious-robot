-- One-off backfill: a message the recipient has read was necessarily
-- delivered to them first, but the read and delivery paths used to be
-- independent, so any read that landed with no prior delivery receipt left
-- `delivered_to` empty forever. Idempotent (`delivered_to = '{}' OR NULL`
-- narrows this to exactly the rows still missing the entry, so re-running it
-- after the code fix — or after some rows have already been backfilled —
-- is a no-op for those rows).
UPDATE "messages"
SET "delivered_to" = array_append(coalesce("delivered_to", '{}'), "recipient_id")
WHERE "read_at" IS NOT NULL
  AND (
    "delivered_to" IS NULL
    OR NOT ("delivered_to" @> ARRAY["recipient_id"]::text[])
  );
