# Implementation guideline — remaining decisions and gaps

Audited against `ab7591677e979d0a86b1137e99743fc5f3bdc5fd` on 2026-10-02.
This is not a backlog of previously completed chat/call work.

## Product and implementation gaps

| Gap | Evidence / decision |
| --- | --- |
| Group calls | The call record and signalling protocol still model a caller and callee, not a group media topology (`shared/signaling/schemas.ts`, `server/src/domain/calls.ts`). |
| Group messaging | Deferred by [group-messaging-mvp.md](./group-messaging-mvp.md) until its admission/history model is reviewed against the E2EE decision. This is a product/protocol gate, not authorization to start implementation. |
| Production messaging E2EE | [e2ee-design.md](./e2ee-design.md) records a no-go; the current message schema and push previews remain server-readable. |
| Remote crash reporting | Sentry is selected in [crash-reporting-decision.md](./crash-reporting-decision.md), but is not a dependency in `mobile/package.json`. `crashReporter.ts` saves local reports and `observability.ts` exposes an additional-sink interface. |
| iOS build CI | The checked-in mobile CI runs typecheck, lint and Jest on Ubuntu; the native build workflow builds Android. There is no iOS build workflow. |
| Internationalization | User-visible strings remain embedded in components. The recorded 2026-09-17 roadmap #403 decision deprioritizes #305 until a concrete target locale/market is required, without duplicating or reparenting it from #299; it is not the next mandatory engineering task. |

An accessibility audit and device QA cannot be declared complete from a count
of labels or from unit tests. Use physical-device evidence for background push,
system call UI, audio routing, screen sharing and PiP; the system-audio checks
are in [android-system-audio-decision.md](./android-system-audio-decision.md#5-what-still-needs-hardware).

## Operational boundaries

- Keep production `CORS_ORIGIN` intentionally restricted.
- Rate limiters built by `server/src/security.ts` use process-local buckets;
  shared session/presence storage does not make these fleet-wide limits.
- Prometheus scraping and alert deployment require operational verification,
  not inference from the existence of `/metrics`.

Account deletion and export are implemented in
`server/src/routes/accountDeletion.routes.ts` and
`accountExport.routes.ts`; they are not missing endpoints to schedule again.
Likewise, local chat persistence uses SQLite
(`mobile/src/storage/localDatabase.ts`), not a deferred whole-document JSON
replacement.
