# Severity rubric

Shared by the `grumpy-code-reviewer` and `fix-review-findings` skills so a
finding means the same thing in both directions (reviewing and fixing).

| Severity | Definition | Examples |
|---|---|---|
| **Critical** | Breaks the build/compile, crashes at runtime, or is a directly exploitable vulnerability / data-loss bug reachable in normal use. | Reference to an out-of-scope variable that fails to compile; a null-deref on the happy path; unauthenticated write to another user's data. |
| **High** | Real security/privacy risk, a correctness bug reachable in normal use, or a major performance regression — not code-breaking, but wrong or dangerous. | An over-broad permission request; an exported component that can be triggered by any other app to change app/device state; an O(n²) loop over a list that is regularly large. |
| **Medium** | Design/maintainability problem, including SOLID violations, missing error handling on a realistic (not just theoretical) failure path, or a moderate performance concern. | A function/hook/class taking on unrelated responsibilities (SRP); tight coupling to a third-party library's internal classes instead of an abstraction (DIP); a missing `try/catch` around a call that can realistically throw. |
| **Low** | Consistency, readability, or minor performance nit that does not change behavior. | A new ESLint warning; a magic number that should be a named constant; inconsistent naming vs. the surrounding file. |
| **Nit** | Cosmetic / stylistic; purely optional. | Comment wording, minor formatting preferences. |

## Ground rules for using this rubric

- Every finding must cite a concrete `file:line` (or `file` + symbol name) and
  explain *why it matters*, not just *that it's there*. No vague "this could
  be cleaner" — say what's wrong and what a fix looks like.
- Prefer evidence over speculation: run the project's own lint/build/test
  tools where available instead of guessing whether something is broken.
- A finding introduced by the diff under review is judged against this
  rubric on its own merits. Pre-existing problems the diff merely *touches*
  (without making worse) are out of scope for severity scoring — mention
  them only as a footnote, don't grade them.
