# Crash-reporting vendor decision

**Status: accepted — Sentry (React Native).**

## Decision

Use `@sentry/react-native` for JavaScript and native crash reporting when crash
reporting is integrated. This is a vendor decision; the SDK and its native
configuration are now wired (optionally, see below — `mobile/src/crashReporting.ts`),
and Android APK CI uploads Hermes source maps before publishing reporting-enabled
release APKs. Native-symbol upload remains follow-up work.

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

The integration and CI source-map upload use:

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

### Android APK CI setup

In repository **Settings → Secrets and variables → Actions**, set:

- Secrets: `SENTRY_DSN` (the runtime endpoint) and `SENTRY_AUTH_TOKEN` (an upload
  token authorized for the project, including `org:read` and `project:releases`).
- Variables: `SENTRY_ORG` and `SENTRY_PROJECT` (slugs), and optionally `SENTRY_URL`
  for self-hosting (defaults to `https://sentry.io/`).

The token is exposed only to the upload step, never to Gradle or Babel. PRs skip
uploads entirely and need no upload credentials. Non-PR builds without a DSN
remain credential-free; when a DSN is configured, missing upload configuration
or failed processing blocks APK publication rather than shipping unreadable
release stacks.

CI inlines `SENTRY_RELEASE=com.wetalk@<commit SHA>` and
`SENTRY_DIST=<run ID>.<run attempt>` and passes the exact same values to the CLI.
`Sentry.init` uses these explicit identifiers; local builds without them retain
the SDK's native version/build defaults. Gradle tracks all three Sentry bundle
configuration values as task inputs so its build cache cannot reuse stale
identifiers. A rerun gets a new dist even at the same commit.

The upload uses the locked SDK's transitive `sentry-cli` (3.x) React Native
command with the release bytecode bundle and the **composed Metro + Hermes map**
at `android/app/build/generated/sourcemaps/react/release/index.android.bundle.map`.
The React Native Gradle plugin registers one `createBundleReleaseJsAndAssets`
task per variant, not per ABI: the CI arm64-only and local four-ABI builds use
the same bundle/map layout.

The CLI uploads both files as one checksummed artifact bundle, then assembles
it on the server; interrupted chunk transfers do not publish half a map via
individual release-file replacement. `--wait` requires successful server
processing before the workflow publishes the APK. Existing workflow cancellation
stays enabled: a cancelled run can leave unused chunks or a complete bundle, but
its unique release/dist cannot overwrite a later build's maps. Self-hosted Sentry
must support artifact-bundle uploads; there is no legacy individual-file fallback.

To verify end-to-end, dispatch a reporting-enabled release build, install its APK,
and capture a known JS exception. Confirm the event's release/dist match the
workflow and its stack resolves to the original TypeScript file and line. This
requires the repository configuration above and access to the Sentry project;
unit tests alone cannot prove server-side symbolication.

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

The global JavaScript handler also forwards exceptions through the optional
shim, without waiting before chaining to the previous handler. Console output
and the full local crash file remain available even when remote reporting fails.
Remote captures include fatality, the bundle version, the signaling **host only**
(not URL credentials, paths or queries), and the active call-state-machine phase.
The last 100 buffered log entries are attached as diagnostic envelopes
(timestamp, level, approved component label and call phase); free-form log text
and metadata stay local. Structured remote breadcrumbs likewise retain only
timestamp, numeric metric value and validated call phase. Custom error properties
are excluded, and emails and labelled identity/content fields in error details
are redacted. Automatic console/network breadcrumbs are dropped because they
bypass this allowlist. Do not put message bodies or attachment keys in exception
text.
The app's handler is the sole `ErrorUtils` capture path: Sentry's
`ReactNativeErrorHandlers` integration uses `onerror: false` to avoid
deduplicating away the enriched event. Its production promise-rejection tracker,
native crash reporting and the other integrations remain enabled.
Remote delivery, like the asynchronous local file write, is best-effort: the
handler does not wait for an SDK flush before chaining, so immediate fatal
process termination may interrupt delivery.
