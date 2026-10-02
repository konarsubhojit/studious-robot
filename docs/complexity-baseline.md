# Cognitive complexity — gate and decomposition rationale

Audited against `ab7591677e979d0a86b1137e99743fc5f3bdc5fd` on 2026-10-02.

## The gate

`sonarjs/cognitive-complexity` is configured as **`error` at 15** in both
`server/eslint.config.js` and `mobile/.eslintrc.js`. The server lint script
covers `server/` and `shared/`; the mobile script runs the package's legacy
ESLint configuration.

Cognitive complexity was chosen over cyclomatic complexity because it
penalises nesting rather than treating a flat guard-clause sequence as
equivalent to deeply nested control flow. The gate protects reviewability,
not a line-count target.

Use the existing package commands to measure the current checkout:

```bash
npm --prefix server run lint
npm --prefix mobile run lint
```

Historical violation scores and file sizes are not a live backlog. No current
lint result is asserted by this documentation-only audit.

## Decomposition decisions retained

- Long files and complex functions are different problems. A module with many
  small functions can benefit from decomposition even without exceeding the
  cognitive-complexity threshold.
- The server's `push.ts`, `messageStore.ts`, `createServer.ts`,
  `signaling/index.ts` and `signaling/messageHandlers.ts` remain import
  facades over focused implementation directories.
- Mobile messaging separates history, send/receive pipelines, identity,
  conversation projection and drafts under `mobile/src/messaging/`.
- Call decisions live under `mobile/src/call/`; effectful concerns are
  composed by `useCallFlow`. See
  [the completed extraction record](./CALLFLOW_EXTRACTION.md) for the
  teardown boundary intentionally left in the composition root.

Do not weaken the gate merely to make a decomposition pass green. If an
exception is proposed later, record the specific function and reasoning rather
than reviving an obsolete baseline score table.
