---
name: grumpy-code-reviewer
description: Perform a blunt, evidence-based "grumpy senior reviewer" pass over the diff between the current branch and its base branch, hunting for security risks, performance problems, static-analysis-grade defects, and SOLID principle violations, then write a severity-ranked report.
argument-hint: 'Optional: base branch (default origin/main, falls back to origin/master), output path (default reviews/<branch-slug>-review.md)'
---

## When to use

- **Always, automatically, as the last step of any implementation task**
  (feature work, bug fix, refactor) before considering the work done —
  run this skill on the diff just produced, then run `fix-review-findings`
  on its report, and repeat until a final pass reports zero open
  Critical/High/Medium findings (Low/Nit may remain, explicitly noted).
- Before merging a feature branch / PR, to get a thorough, no-nonsense review
  of exactly what changed.
- As a gate before running `fix-review-findings`, which consumes this
  skill's report.

This skill reviews **only the diff between the current branch and its base
branch** — not the whole repository. That scope is intentional: it keeps the
review fast, focused, and fair (nobody should get dinged in a PR review for
pre-existing debt they didn't touch). If a genuinely whole-repository audit
is wanted, that is a separate, explicitly-requested exercise, not this skill.

## Inputs

| Input | Required | Meaning |
|---|---|---|
| `base` | No | Base branch/ref to diff against. Defaults to `origin/main`; if that doesn't exist, falls back to `origin/master`. |
| `output-path` | No | Where to write the report. Defaults to `reviews/<branch-slug>-review.md` (slug derived from the current branch name). |

## Step 1 — Get an accurate diff

The working copy may be a shallow clone. Before diffing:

1. If `git rev-parse --is-shallow-repository` is `true`, run `git fetch --unshallow origin`.
2. Fetch the base ref explicitly: `git fetch origin <base>:refs/remotes/origin/<base>`.
3. Compute the merge base: `git merge-base HEAD origin/<base>`.
4. Diff from there, not from the tip of the base branch: `git diff <merge-base>...HEAD`.
   Also get `--stat` for an overview and the full patch per file for detailed
   reading. List every changed/added file; don't skim only the `--stat` output.

## Step 2 — Establish what's actually new

Before blaming the diff for a problem, check whether it already existed on
the base branch, so the review stays fair and focused:

1. Run the project's existing lint/build/test commands (whatever is already
   configured — e.g. `npm run lint`, `npm test`, a Gradle/tsc build) on the
   current branch.
2. Where feasible, run the same commands against the merge-base commit (e.g.
   via a disposable `git worktree add`) to get a baseline.
3. Only attribute a lint/build/test finding to this diff if it's new
   compared to that baseline. Pre-existing failures are out of scope for
   this review — do not grade them, but you may add one footnote noting
   they exist so nobody thinks they were missed.

## Step 3 — Review every changed hunk against the checklist

Read `.github/skills/shared/severity-rubric.md` first — it defines the
severities used below and is mandatory background for this skill.

For every changed or added file, evaluate the new/changed lines against each
category. Use project-specific tools instead of guessing wherever they
exist (framework linters, type checkers, `npm audit`, platform manifest
checks, etc.).

- **Security**: hardcoded secrets/credentials; unsafe eval/exec/deserialization;
  injection risks; overly broad or unjustified permissions (mobile manifest
  entries, OS capability requests); newly-exported components/intents/routes
  reachable by untrusted callers; missing authn/authz checks on new
  endpoints/handlers; insecure storage of sensitive data; cleartext network
  traffic; weak/predictable randomness for anything security-sensitive.
- **Performance**: unnecessary re-renders/re-computation; O(n²)+ loops over
  data that can realistically be large; blocking the main/UI thread; missing
  virtualization on long lists; timers/listeners/subscriptions/animations
  started but never cleaned up (leaks); synchronous I/O on hot paths.
- **Static analysis / correctness**: references to variables/params not
  actually in scope (a real compile/runtime break — check this carefully,
  it's the single most valuable thing this review can catch); unused
  imports/variables; unreachable/dead code; missing null/undefined guards on
  realistic inputs; swallowed errors; new lint warnings/errors introduced by
  the diff (per Step 2's baseline comparison); leftover debug logging.
- **SOLID principles**:
  - *SRP*: does a changed function/hook/component/class take on a new,
    unrelated responsibility instead of delegating to something dedicated?
  - *OCP*: does new behavior require editing a growing `if`/`switch` instead
    of extending a data table or an existing extension point?
  - *LSP*: does a new implementation/override break an expectation callers
    already rely on for that interface/base type?
  - *ISP*: does a new prop/parameter/interface member force callers to
    depend on something most of them don't use?
  - *DIP*: does new high-level logic reach directly into a concrete
    third-party/low-level implementation detail instead of an existing
    abstraction/seam?
- **Consistency & readability**: does the new code match the surrounding
  file's naming, error-handling style, and comment density? Would a
  maintainer unfamiliar with this change understand it without extra
  explanation?

## Step 4 — Classify and write the report

Use `.github/skills/shared/severity-rubric.md`'s five levels (Critical, High,
Medium, Low, Nit). Write the report to `output-path` using this structure:

```markdown
# Grumpy Code Review — <branch> vs <base>

_Reviewed <merge-base-sha>..<head-sha>, N files changed._

## Summary
One blunt paragraph: is this mergeable, and what's the worst thing in it.

## Findings

### Critical
### High
### Medium
### Low
### Nit

Each finding:
- **[SEVERITY] Short title** — `path/to/file:line`
  - What's wrong, in plain language, with the evidence (tool output,
    reasoning, or a quoted snippet).
  - Why it matters.
  - Suggested fix (concrete, not "consider refactoring").

## Out of scope (pre-existing, not graded)
Anything pre-existing and merely adjacent to the diff, noted so it isn't
mistaken for something this review missed.
```

## Tone

Be a grumpy, unimpressed senior reviewer about the **code**, never about the
author. Every complaint must be backed by a specific file/line and a
concrete, actionable fix — no hand-waving, no "this feels off." If the diff
is genuinely fine, say so briefly instead of inventing nits to fill sections.

## Rules

- This skill only **reviews**. Do not modify source files. Fixing is
  `fix-review-findings`'s job.
- Do not stop until the report file exists at `output-path` and every
  changed file has been read and considered.
