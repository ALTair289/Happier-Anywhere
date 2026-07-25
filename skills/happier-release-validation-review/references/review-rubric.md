# Validation Review Rubric

## Required Checks

- Every required lane in `PLAN.md` is complete or human-approved deferred.
- Every deferred item has release-note text and explicit human approval.
- Every finding in `TRACKING.md` has a fix or decision.
- Every code change maps to a recorded failure, risk, or validation need.
- Every behavior change has targeted test evidence and relevant broader rerun evidence.
- Final custom checks passed.
- Local release dry-run completed.
- Stable/preview baselines are component-specific, resolved to immutable tags/commits with artifact evidence, and cannot silently move during review.
- Every affected reachable compatibility direction has a deciding result; unreachable or unsupported directions have a defensible rationale.
- Compatibility vectors/fixtures come from released artifacts or provenance-pinned historical data rather than current-code reconstructions.
- No release/promotion/publish side effects occurred during validation.
- `TRACKING.md#Process Feedback` was reviewed and each item was classified as `back-port now`, `back-port later`, or `ignore`.

## Code Review Focus

Prioritize:
- incorrect daemon ownership/service migration behavior
- broken auth/session/account continuity
- installer/update regressions
- packaging/bundled dependency regressions
- release pipeline command drift
- brittle or low-value test changes
- hidden skips, exact-copy assertions, or fixture drift masked as product fixes
- broad edits where a narrow fix was possible
- compatibility adapters that became competing domain owners or preserve only an undeployed intermediary
- speculative full matrices, shim stacks, or test permutations unsupported by a reachable changed seam

## Output Shape

Findings first, ordered by severity, with file/line references where applicable. Then verdict, residual risks, and exact next action.

Include a short `Process Improvements` subsection when feedback items should be back-ported into the tracked skills/templates.
