---
name: happier-release-validation-review
description: Review a completed Happier release-validation worktree before any preview promotion. Audits validation fixes, diffs, evidence, lane completion, unresolved risks, and dry-run output. Read-only by default and never releases.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release Validation Review

Use this skill after `happier-release-validation` finishes and before any release or preview promotion.

## Mission

Act as a skeptical release-candidate reviewer. Verify that the validation branch changes are correct, necessary, root-cause-oriented, well-tested, and supported by evidence. Do not promote or release.

## Inputs

- Validation worktree path
- Live workspace under `.project/reviews/<date>-v<version>-release-validation/`
- `TRACKING.md`, `PLAN.md`, `LEDGER.md`, lane docs, evidence directory
- `git diff` for the validation branch
- final custom checks result
- local release dry-run output

## Process

1. Re-read `AGENTS.md`.
2. Read `references/review-rubric.md`.
3. In the validation worktree, read `TRACKING.md`, `PLAN.md`, and `LEDGER.md`.
4. Verify every completed lane has evidence for its claim.
5. Review every code change made during validation with normal code-review severity.
6. Confirm tests follow TDD expectations where behavior changed.
7. Confirm no workaround fixes, hidden skips, destructive cleanup, or release side effects happened.
8. Review `TRACKING.md#Process Feedback` and classify each item as `back-port now`, `back-port later`, or `ignore`.
9. Produce a concise sign-off packet.

## Re-measure, don't re-read

This review is an adversarial pass over another agent's claims. Treat every number and every "green" in the validation report as unverified until reproduced:

- Rerun the release dry-run yourself and compare against the recorded output.
- Rerun at least one claimed-green lane at the exact recorded commit/basis; attribute any difference to concurrent churn explicitly before accepting it.
- Re-measure reported metrics (LOC deltas, counts, timings) with the same command the lane claims to have used.
- A report referencing files that do not exist, or a lane green only against a dirty tree, downgrades the verdict to `NEEDS_MORE_EVIDENCE` at minimum.

## Verdicts

- `APPROVE_FOR_PREVIEW_PROMOTION`: evidence and diffs support promotion.
- `NEEDS_FIXES`: specific issues must be fixed before promotion.
- `NEEDS_MORE_EVIDENCE`: claims may be true but evidence is insufficient.
- `BLOCKED`: cannot review because required inputs are missing.

This skill is read-only by default. If fixes are required, ask before editing or direct the user back to `happier-release-validation` for another fix/validation loop.
