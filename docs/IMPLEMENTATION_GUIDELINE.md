# Implementation guideline — remaining decisions and gaps

Audited against `ab7591677e979d0a86b1137e99743fc5f3bdc5fd` on 2026-10-02.
This is not a backlog of previously completed chat/call work.

## Product and implementation gaps

| Gap | Evidence / decision |
| --- | --- |
| Group calls | [group-call-topology.md](./group-call-topology.md) selects a four-participant mesh launch and requires topology-neutral group signalling to permit a later SFU migration without another protocol break. |
| Group messaging | Admission, pre-join history visibility, roles, blocks, lifecycle, and size cap are resolved in [group-messaging-mvp.md](./group-messaging-mvp.md); the server-readable MVP closes the E2EE-related deferral under the recorded no-go. |
| Production messaging E2EE | [e2ee-design.md](./e2ee-design.md) records a no-go; the current message schema and push previews remain server-readable. |
| Remote crash reporting | Optional Sentry reporting is wired through `crashReporting.ts` for global JS/native crashes and handled React render errors, with diagnostic breadcrumbs and CI Hermes source-map uploads. Local reports remain available through `crashReporter.ts`. See [crash-reporting-decision.md](./crash-reporting-decision.md) for required repository configuration and end-to-end verification; native-symbol upload remains follow-up work. |
| iOS build CI | The checked-in mobile CI runs typecheck, lint and Jest on Ubuntu; the native build workflow builds Android. There is no iOS build workflow. |
| Internationalization | User-visible strings remain embedded in components. The recorded 2026-09-17 roadmap #403 decision deprioritizes #305 until a concrete target locale/market is required, without duplicating or reparenting it from #299; it is not the next mandatory engineering task. |

An accessibility audit and device QA cannot be declared complete from a count
of labels or from unit tests. Use physical-device evidence for background push,
system call UI, audio routing, screen sharing and PiP; the system-audio checks
are in [android-system-audio-decision.md](./android-system-audio-decision.md#5-what-still-needs-hardware).

## Operational boundaries

- Keep production `CORS_ORIGIN` intentionally restricted.
- With `REDIS_URL`, all twelve security rate budgets use atomic Lua counters
  with TTLs on the existing bus command client, with explicit limiter namespaces
  and encoded identities. Avatar operations reuse the send/download budgets;
  directory reads currently have no rate budget. Disconnected, failed or slow
  commands fall back to per-instance limits (250 ms deadline, no offline queue);
  timed-out transports probe again after one second, with at most 64 issued
  security commands; requests waiting for a slot share the same deadline.
  `/health.rateLimit` reports local degradation and recovery after a successful
  shared check. Warnings are limited to once per minute per transport.
- Shared block enforcement reads PostgreSQL directly, not startup Maps or a
  Redis block cache: this avoids stale allows and resurrecting unblocks during
  hydration. Shared add/remove/list and account erasure use the same authority.
  Privacy checks fail closed on store failure (hidden directory/results or
  existing forbidden responses); mutations/listing return 503, never stale
  success. Shared mode without a block backend also fails closed. Redis outages
  do not bypass blocks because no Redis block reads are involved. The extra
  database reads trade cache efficiency for fleet-wide privacy correctness.
- Prometheus scraping and alert deployment require operational verification,
  not inference from the existence of `/metrics`.

Account deletion and export are implemented in
`server/src/routes/accountDeletion.routes.ts` and
`accountExport.routes.ts`; they are not missing endpoints to schedule again.
Likewise, local chat persistence uses SQLite
(`mobile/src/storage/localDatabase.ts`), not a deferred whole-document JSON
replacement.
