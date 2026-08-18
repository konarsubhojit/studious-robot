-- One-off cleanup: close every call row stranded in a non-terminal state.
--
-- Calls that reached `accepted` / `connecting_media` / `in_call` (or that were
-- left `ringing`) were never swept to a terminal state, so they were rehydrated
-- as active on every restart and permanently marked both participants busy.
UPDATE "calls"
SET "status" = 'ended',
    "end_reason" = 'stale_cleanup',
    "ring_timeout_at" = NULL,
    "updated_at" = now()
WHERE "status" NOT IN ('ended', 'missed', 'declined', 'busy', 'unreachable');
