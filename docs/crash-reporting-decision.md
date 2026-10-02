# Crash-reporting vendor decision

**Status: accepted — Sentry (React Native).**

## Decision

Use `@sentry/react-native` for JavaScript and native crash reporting when crash
reporting is integrated. This is a vendor decision; adding the SDK, native
configuration, and upload steps is follow-up work.

Sentry's Hermes-aware JavaScript stack traces and support for self-hosting make
it the best fit for diagnosing failures across this React Native app and the
project's self-hosted OCI services. Its Gradle and Xcode build integrations can
upload source maps and native symbols for release builds.

## Alternatives considered

| Vendor | Assessment |
| --- | --- |
| Firebase Crashlytics | Lowest marginal native setup because Firebase is already used and Android applies Google Services only when `google-services.json` exists. It is a strong native crash reporter, but its JavaScript stack and breadcrumb support are weaker for this app's needs. |
| Bugsnag | Comparable crash-reporting capability, but offers no advantage here over Sentry's Hermes support and self-hosting fit. |

## Configuration and secrets

The eventual integration and CI symbol/source-map upload need:

| Setting | Purpose | Secret? |
| --- | --- | --- |
| `SENTRY_DSN` | Runtime endpoint for the selected Sentry project; may be supplied through build-time configuration. | No; the DSN is present in the client app. |
| `SENTRY_AUTH_TOKEN` | CI-only authentication for source-map and native-symbol uploads. | **Yes.** Store as a CI secret; never bundle it in the app. |
| `SENTRY_ORG` | Sentry organization used by the upload step. | No. |
| `SENTRY_PROJECT` | Sentry project used by the upload step. | No. |
| `SENTRY_URL` | Sentry server URL; set this to the self-hosted instance URL when applicable. | No. |

The upload integration must run for release builds and associate uploaded
artifacts with the same release identifier used by the app. Runtime DSN
configuration must not require the upload token.

## Optional native-module and test requirement

Keep reporting optional, following `loadMessaging()` in
`mobile/src/pushNotifications.ts`: do not import Sentry at module scope. Load and
initialize it lazily inside a guarded loader, and treat an absent package,
unavailable native module, or initialization failure as a no-op while retaining
the existing app-log sink. Register reporting through the sink interface in
`mobile/src/observability.ts`, so logging and startup continue if reporting is
unavailable.

Jest must not require Sentry's native module. The guarded loader can be tested
with the package or native module absent, consistent with
`mobile/__tests__/callKeep.test.ts` and the optional-messaging tests. The
acceptance check is `cd mobile && npm test` on Linux with no native module
installed or initialized.
