# Grumpy Code Review — copilot/add-hmac-use-auth-secret vs master

_Reviewed 615edc9..HEAD, 5 files changed._

## Summary

Mergeable. The HMAC tier does exactly what coturn's `use-auth-secret` mode
expects, mints per-user credentials outside the shared Cloudflare cache, and the
mobile hook now builds `RTCPeerConnection` with the fetched ICE servers instead
of the build-time list — which was the actual bug. Server suite (377 pass) and
mobile suite (928 pass) are green, lint and both typechecks are clean. The worst
thing in the diff is a misconfiguration warning that fires on *every* request
instead of once, which will bury a production log.

## Findings

### Critical

None.

### High

None.

### Medium

None.

### Low

- **[LOW] Misconfiguration warning logs on every request** *(fixed)* —
  `server/src/routes/turnCredentials.routes.js:148`
  - When `TURN_STATIC_AUTH_SECRET` is set but `TURN_URL` is not, the
    `console.warn` runs on each `GET /turn-credentials`. With every client
    polling for credentials this floods the log with an identical line that
    conveys no new information after the first occurrence.
  - Why it matters: a permanent misconfiguration turns into unbounded log
    volume, drowning out real errors.
  - Suggested fix: latch the warning behind a per-router boolean so it is
    emitted once per process.

### Nit

- **[NIT] HMAC-SHA1 looks weak but is protocol-mandated** —
  `server/src/routes/turnCredentials.routes.js:55`
  - SHA-1 as a *hash* is broken, but coturn's `use-auth-secret` REST API
    specifically validates `base64(HMAC-SHA1(secret, username))`, and HMAC-SHA1
    has no practical forgery attack. No change needed; the surrounding JSDoc
    already states the reason.

## Out of scope (pre-existing, not graded)

- `getStaticIceServers` still returns an empty `urls` array if `TURN_URL` is set
  to something that parses to nothing (e.g. `","`). Behaviour is unchanged by
  this diff; the parsing was only extracted into `parseTurnUrls`.
- `configurePeerConnection` remains for the ICE-restart path only. It re-applies
  fresh credentials before an ICE restart, where re-gathering is expected, so it
  no longer races initial gathering.
- Jest emits pre-existing `act(...)` warnings from `useCallFlow.test.js`
  (lines 2597, 3124) on master as well.
