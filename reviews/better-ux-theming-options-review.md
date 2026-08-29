# Grumpy Code Review — copilot/better-ux-theming-options vs 9d8c495

_Reviewed 9d8c495..bd925a8, 36 files changed (2486 insertions, 238 deletions)._

## Summary

Mergeable, and better than most diffs this size: the palette-identity constraint
that keeps `useThemedStyles`' cache alive is respected and asserted, persistence
falls back per field, and the contrast guardrail actually iterates the whole
cross-product instead of spot-checking one accent. `npx jest` (109 suites / 1631
tests), `tsc --noEmit` and `eslint src/ __tests__/` are all clean, and the
baseline before this branch was 106/1374 — nothing was deleted to get green.

The worst thing in it is a **lie told by a toast**: `Clear cached media` fires
"Cached media cleared" the instant the row is tapped, before the asynchronous
clear has started, let alone succeeded. The second-worst is a **claim in a
comment that is not true** — the in-app text scale is stated to be protected by
`fontScaleCaps`, and it is not.

## Findings

### Critical

None.

### High

None.

### Medium

- **[MEDIUM] The clear-media toast confirms an outcome it has not observed** —
  `mobile/src/components/SettingsScreen.tsx:417-430`
  - `onPress` calls `onClearCachedMedia()` and then `confirm('Cached media
    cleared')` synchronously. The clear is asynchronous — the screen has an
    `isClearingMedia` prop precisely because it takes long enough to show a
    "Clearing…" title — so the confirmation appears *before* the work starts and
    stays on screen whether it succeeds or fails. A user who taps it on a device
    where the delete throws sees "Cached media cleared" and a storage figure
    that has not moved.
  - Why it matters: a transient confirmation is only worth adding if it means
    something. One that fires on intent rather than outcome is worse than no
    toast, because it teaches the user not to trust the other three.
  - Fix: drive it off the `isClearingMedia` transition — toast when it goes
    `true → false` — rather than off the press. The same applies in spirit to
    `Signaling server saved`, though that one commits synchronously into props
    and is defensible.
  - **Resolution: Fixed.** The confirmation is now driven off the
    `isClearingMedia` `true → false` transition, guarded by a ref so a screen
    that simply mounts with no clear in flight stays silent. Two tests cover it.

- **[MEDIUM] `fontScaleCaps` does not protect anything from the in-app text
  scale, but two comments say it does** — `mobile/src/theme.ts` (`TEXT_SCALE_FACTORS`
  docblock) and `mobile/docs/UX_REDESIGN_PLAN.md` §1
  - `maxFontSizeMultiplier` caps the **OS** font scale applied on top of a
    token's `fontSize`. `setTextScale` changes the `fontSize` itself, so a
    capped `Text` at `larger` renders 1.3× and the cap never sees it. The
    comment "…and `fontScaleCaps` still protects the containers that cannot
    grow" is therefore false exactly where it is load-bearing: the bottom-pinned
    call deck, the tab bar and anything sized from `sizes.*`.
  - Why it matters: the next person to raise `TEXT_SCALE_FACTORS.larger` will
    read that sentence and believe the fixed-height surfaces are safe.
  - Fix: state the actual position — the in-app scale is deliberately capped at
    1.3 *because* nothing else caps it — and add the fixed-height surfaces to
    the §3 device check for text size.
  - **Resolution: Fixed.** The `TEXT_SCALE_FACTORS` docblock now states that
    `fontScaleCaps` does not restrain the in-app scale and that 1.3 is the only
    thing protecting the fixed-height surfaces; §1 of the plan says the same,
    and §3.4 gained a second walk at Text size = Larger.

### Low

- **[LOW] `baseTypography` exports the mutable base table by reference** —
  `mobile/src/theme.ts` (`export const baseTypography = BASE_TYPOGRAPHY`)
  - `typography` is a defensive clone, but the table it is recomputed *from* is
    handed out raw. Anything that mutated `baseTypography.body.fontSize` would
    silently corrupt every subsequent `setTextScale`, and the corruption would
    survive as a wrong font size rather than an error.
  - Fix: freeze the token objects, or export a clone.
  - **Resolution: Fixed.** `baseTypography` is now a clone of the base table.

- **[LOW] `setPreference` performs I/O inside a `setState` updater** —
  `mobile/src/ThemeProvider.tsx`
  - `void saveThemePreferences(next)` runs inside the reducer passed to
    `setPreferences`. React does not promise to call an updater exactly once
    (StrictMode double-invokes it in development), so this can write twice.
  - Why it matters: harmless today — the write is idempotent and the file is
    tiny — and it matches `useAppSettings.persistSetting`, which does the same.
    Noted so it is a known pattern rather than an accident.
  - Fix (if it is ever worth it): compute `next` outside the updater.
  - **Resolution: Fixed.** `setPreference` builds and writes the next value
    outside the updater, using a ref that is assigned synchronously so two
    changes in the same tick still compose.

- **[LOW] The `-v27` style variants duplicate the base theme wholesale** —
  `mobile/android/app/src/main/res/values-v27/styles.xml`,
  `values-night-v27/styles.xml`
  - Android replaces the whole `AppTheme` for the qualified configuration, so
    duplication is forced rather than sloppy — but an item added to the base
    theme later will silently not apply on API 27+.
  - Mitigation already present: `__tests__/androidWindowBackground.test.ts`
    asserts the three window/bar colours in every variant. Extend that list when
    an item is added.
  - **Resolution: Fixed (documented).** The duplication is forced by Android
    resource resolution, so the guard test now carries a comment saying an item
    added to the base theme must be added to the variants and to its list.

- **[LOW] A component rendered outside `ThemeProvider` never sees a text-size
  change** — `mobile/src/ThemeContext.ts` (`defaultTheme`)
  - `defaultTheme` captures `getTypographyRevision()` at module load, so its
    `typographyRevision` is frozen at 0.
  - Only unit tests render outside the provider, so this is a documentation
    point, not a defect.
  - **Resolution: Fixed (documented).** Stated as a limit in the `defaultTheme`
    docblock.

### Nit

- **[NIT] `confirm` in `SettingsScreen` is redeclared every render** —
  `mobile/src/components/SettingsScreen.tsx`
  - `dismissToast` is a `useCallback` and `confirm` is not, which reads as an
    inconsistency rather than a decision. It is passed to nothing memoised, so
    it changes no behaviour.

## Out of scope (pre-existing, not graded)

- The Jest run ends with "A worker process has failed to exit gracefully"; this
  predates the branch and reproduces on the merge base.
- `SettingsScreen` still hosts the hand-rolled ICE-policy segmented control
  rather than `primitives/SegmentedControl`. The Appearance group was migrated;
  this one was left alone because it is behind developer mode and out of scope.

---

## Fix pass summary

7 findings, **7 fixed, 0 deferred**: 2 Medium, 4 Low, 1 Nit (no Critical or
High were raised). Validation after the pass: 109 suites / 1632 tests passing,
`tsc --noEmit` and `eslint src/ __tests__/` clean. No test was deleted or
loosened; the clear-media toast test was rewritten because the behaviour it
asserted was the defect.
