---
name: fix-review-findings
description: Read a review report produced by grumpy-code-reviewer and fix its findings, ordered by severity, scoped strictly to the branch's diff against its base branch — preserving consistency and readability, and explicitly resolving flagged SOLID violations.
argument-hint: 'Optional: path to the review report (default: most recent reviews/*.md)'
---

## When to use

- **Always, automatically, as the last step of any implementation task**,
  immediately after `grumpy-code-reviewer` has produced a report for the
  work just done, to act on it before the task is considered complete.
- Immediately after `grumpy-code-reviewer` has produced a report, to act on
  it.

This skill fixes **only findings that fall within the reviewed diff**
(the same branch-vs-base-branch scope the report was generated from). If the
report contains an "Out of scope (pre-existing, not graded)" section, or any
finding explicitly marked as pre-existing/whole-repository debt, leave it
alone — do not expand the blast radius of this run into unrelated parts of
the codebase. A broader repository-wide remediation is a separate, explicitly
requested exercise.

## Inputs

| Input | Required | Meaning |
|---|---|---|
| `report-path` | No | Path to the report to act on. Defaults to the most recently modified `reviews/*.md`. |

## Step 1 — Load and triage findings

1. Read `.github/skills/shared/severity-rubric.md` for the severity
   definitions this report was written against.
2. Parse the report's `Findings` section into individual items, keeping each
   item's severity, file/line, and suggested fix.
3. Discard (do not touch) anything under "Out of scope (pre-existing, not
   graded)" or otherwise marked pre-existing/whole-app.
4. Order the remaining findings **Critical → High → Medium → Low → Nit**.

## Step 2 — Fix each finding, in order

For each finding, in severity order:

1. Re-locate the issue in the current working tree (line numbers may have
   drifted since the report was written).
2. Apply the smallest correct fix that fully resolves it, matching the
   surrounding file's existing conventions (naming, error handling, comment
   density). Don't use this pass to also refactor unrelated nearby code.
3. **SOLID findings specifically**: perform an actual, scoped refactor (e.g.
   extract a dedicated function/hook/class for a misplaced responsibility;
   invert a dependency onto an existing abstraction instead of a concrete
   third-party internal). Do not just add a comment acknowledging the smell.
   If a full fix would require a disproportionate, high-risk rewrite of code
   well beyond the diff's blast radius, it is acceptable to defer — but only
   with a written rationale in the updated report (see Step 4), never a
   silent skip.
4. After each fix (or small batch of closely related fixes), re-run the
   project's existing lint/build/test commands for the area touched, so a
   regression is caught immediately rather than at the end.
5. Never weaken the test suite to make it pass: don't delete, skip, or loosen
   assertions. If a test's expectation was simply wrong given an intentional
   behavior change from a fix, update it and say so explicitly when
   summarizing.

## Step 3 — Full validation

Once every in-scope finding has been addressed:

1. Run the full lint suite.
2. Run the full test suite.
3. Run a build/type-check/compile step if the project has one and it's
   feasible in this environment.
4. Fix any regression these surface before moving on.

## Step 4 — Update the report in place

Do not delete or rewrite the original findings. For each finding this skill
acted on, append a resolution line directly under it, e.g.:

```markdown
- **[HIGH] Over-broad permission requested** — `path/to/file:42`
  ...original finding text...
  - **Resolution: Fixed.** Removed the permission from the manifest, the
    runtime request list, and the CI permission check; updated tests.
```

Use one of:
- `Resolution: Fixed.` + one line on what changed.
- `Resolution: Deferred.` + the concrete reason it's out of proportion for
  this pass (e.g. "requires a repo-wide rewrite of X, tracked separately").

Add a short summary at the top or bottom of the report: how many findings
were fixed vs. deferred, per severity.

## Step 5 — Re-review gate (no Critical/High/Medium left open)

A single fix pass can introduce its own new issues. Before the task is
considered done:

1. Re-run `grumpy-code-reviewer` against the same base branch.
2. If the new report contains any open (non-deferred) Critical, High, or
   Medium finding, go back to Step 2 and fix it, then repeat this gate.
3. Only Low/Nit findings (fixed or explicitly deferred with rationale) may
   remain open in the final report. Do not loop indefinitely chasing Low/Nit
   items if they're reasonably deferred — the gate is specifically
   Critical/High/Medium.

## Rules

- Stay inside the diff's blast radius: touch only files/areas the review
  actually flagged (plus tests directly covering them). Do not go fix
  unrelated pre-existing issues you happen to notice while in a file.
- Every fix must be validated (Step 2.4 / Step 3) before being considered
  done — "I made the edit" is not the same as "I confirmed it works."
- Do not stop until every non-deferred finding has a `Resolution:` line, the
  full validation in Step 3 is green, and the Step 5 gate is clear.
