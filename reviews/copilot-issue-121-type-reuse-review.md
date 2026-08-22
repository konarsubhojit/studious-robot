# Grumpy Code Review — copilot/issue-121 (type-reuse pass) vs fa0cc5b

_Reviewed fa0cc5b..HEAD, 238 files changed (+1722 / −4222)._

`origin/main` / `origin/master` are not fetchable in this sandbox (the remote
only advertises `copilot/issue-121`), so the base used is `fa0cc5b`, the branch
tip at clone time and the parent of every commit in this session.

## Summary

Mergeable, and mostly subtraction, which is the best kind of diff. The session
does three mechanical things — name the anonymous prop/param object types, turn
inline `import('mod').X` references into real `import type` statements, and
delete the JSDoc type annotations that `tsc` has ignored ever since the files
became `.ts` — plus one small piece of genuine design work: presence /
contact-row / conversation-row shapes now live once in
`mobile/src/types/directory.ts` instead of being redeclared in five screens.
Behaviour is untouched: no runtime statement was edited, only types, comments
and imports. Verified locally — mobile `typecheck` clean, `lint` clean (the two
pre-existing `no-shadow` warnings are gone), 934 jest tests pass; server
`typecheck` clean, 377 node tests pass, 1 skipped. The worst thing in the diff
is that `PeerPresence.online` was widened to optional to fit every call site;
that is a deliberate trade, not a bug, but it is the one place a reviewer should
look twice.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] `PeerPresence.online` widened from required to optional** —
  `mobile/src/types/directory.ts:11`
  - The consolidated type makes `online` optional so it also fits
    `PeerProfileScreen`'s old `{ online?: boolean; status?: string }` shape.
    Consumers that previously got a guaranteed boolean now get
    `boolean | undefined`.
  - Why it matters: `undefined` is falsy, so every current consumer keeps
    behaving the same, but a future `presence.online === false` check would
    silently stop distinguishing "offline" from "not fetched yet".
  - Suggested fix (not applied, deliberately): keep the single type but treat
    "not yet known" as the existing `unknown` flag rather than as a missing
    `online`, and tighten `online` back to required once
    `PeerProfileScreen`'s caller always supplies it. Tracked as follow-up
    rather than churned in a type-only PR.

### Low

- **[LOW] Some `@returns` prose now wraps oddly** —
  e.g. `mobile/src/attachmentPicker.ts:79`
  - Removing the multi-line `{...}` payload left the description starting on
    the tag line and continuing on the next (`@returns \`null\` when the` /
    `module isn't linked...`).
  - Why it matters: purely cosmetic; the sentence still reads correctly.
  - Suggested fix: reflow those handful of comments the next time the
    surrounding function is edited.

### Nit

- **[NIT] `ContactResult` is now an alias of `ContactRow`** —
  `mobile/src/components/SearchScreen.tsx:30`
  - Two names for one shape survive so the screen's existing public export
    doesn't break.
  - Suggested fix: collapse to `ContactRow` when a future change already
    touches the search screen's callers.

## Out of scope (pre-existing, not graded)

- The test suites' `as any` escape hatches (called out in the previous review
  on this branch) are untouched here; this pass deliberately did not rewrite
  test typing.
- `mobile/src/components/Lobby.tsx` still takes 25+ props. Its props now have a
  name (`LobbyProps`) but the prop-drilling itself is the subject of a separate
  issue.
