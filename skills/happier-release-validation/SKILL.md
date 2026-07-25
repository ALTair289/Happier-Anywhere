---
name: happier-release-validation
description: Run a local-first Happier release validation cycle for a candidate version before preview promotion. Creates a validation worktree and ignored tracking workspace, orchestrates parallel checks, deep manual QA on Lima/macOS/Windows, root-cause fixes, evidence capture, independent reviews, and a final dry-run. This skill never promotes or releases.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release Validation

Use this skill when asked to validate a Happier release candidate such as `v0.2.6` before promoting `dev` to `preview`.

## Mission

Validate the current development release lane end-to-end before preview promotion, with special focus on user upgrade safety: installations, daemon ownership, background services, daemon-server auth, session creation, session continuity, provider launches, web UI, native mobile, server, CLI, and release artifacts.

This skill may create branches/worktrees, run local checks, run VM/host QA, and implement root-cause fixes. It must not publish, promote, submit mobile builds, or trigger production/preview release side effects.

Candidate validation must use local candidate artifacts. Released baselines come from the active stable and preview components affected by the candidate. Resolve each rolling channel pointer to an immutable component version tag/commit plus artifact checksum or equivalent release evidence before testing. After seeding a released baseline, upgrades and candidate checks use locally built artifacts from the validation worktree, `--source local-build --ref .`, or an explicitly recorded local artifact transfer to the target machine.

## Start

1. Read `docs/release-process.md`.
2. Read `references/workflow.md` for the orchestration loop and human gates.
3. Read `references/lane-catalog.md` for current lanes and commands.
4. Read `references/manual-qa-matrix.md` before any OS QA lane.
5. Read `references/daemon-ownership-scenarios.md` before lane L21.
6. Read `skills/happier-compatibility` and `docs/compatibility.md`; during Phase 0 record immutable per-component stable/preview baselines and the affected reachable version-skew directions.
7. During Phase 0, read the prior battle-tested release-readiness run at `.project/reviews/2026-04-15-preview-release-readiness-orchestrated-audit/` if it exists. Harvest still-relevant scenarios into the new run instead of rediscovering them.
8. Bootstrap the run:

```bash
node skills/happier-release-validation/scripts/bootstrap-release-validation.mjs --version <version>
```

If the worktree path or branch already exists, stop and ask the user. Do not overwrite, delete, reset, restore, or clean anything.

## Live State

The bootstrap script creates live state under:

```text
.project/reviews/<date>-v<version>-release-validation/
```

Those files are intentionally gitignored. They are the live source of truth for the running validation, not release artifacts to commit.

After bootstrapping, work exclusively inside the created worktree. First read:

1. `TRACKING.md`
2. `PLAN.md`
3. `LEDGER.md`

After any compaction, interruption, or handoff, repeat that read sequence and continue from the first `[~]`, `FAILED`, or `[BLOCKED]` marker.

## Autonomy

Proceed automatically through all reversible local validation, QA, evidence capture, and root-cause fixes.

Stop and ask only for:
- destructive git or filesystem cleanup
- external side effects such as release, promotion, publish, store submission, account deletion, or production changes
- missing secrets or credentials
- branch/worktree/path collisions
- a fix that requires major wire protocol changes, broad architecture changes, or >50-file edits
- a fix that changes release/agent harness behavior such as `.claude/hooks/`, `.claude/agents/`, `scripts/pipeline/run.mjs`, or `scripts/pipeline/checks/**`
- evidence that cannot be made trustworthy

## Parallelism

Keep useful work in flight without a hardcoded agent cap or required minimum:
- use available capacity for ready independent auditors, reviewers, and fix lanes when it shortens the critical path;
- coordinate fix agents around actual overlapping hunks, incompatible seam decisions, generated outputs, and exclusive mutable resources—not dirty files or prior edits;
- limit OS/manual QA concurrency only by real machines and mutable daemon/service state.

Begin automated validation with a parallel failure-collection sweep by resource group. Collect failures before fixing unless one blocker prevents trustworthy evidence collection.

Cluster failures by root-cause surface, not by package. Use focused responsibilities such as `apps/ui new-session composer`, `apps/cli service takeover`, `packages/tests UI fixture`, or `scripts/pipeline installer local-build`, and give each fix agent expected paths plus any shared seam/resource coordination.

Delegate lane-sized work, not tiny errands. Each lane agent should own execution, evidence, diagnosis, in-scope root-cause fixes, targeted reruns, and lane-doc updates. As agents complete, update `PLAN.md`/`LEDGER.md` and dispatch the next safe non-colliding lane while other agents keep running.

Add lanes dynamically when new risks surface. The 27 generated lanes are a starting map, not a ceiling.

## Test Fix Discipline

Follow `AGENTS.md` testing rules. In release validation, this especially means: do not patch stale local mocks across many test files; first inspect and improve the owning shared testkit/mock/factory. Use TDD for behavior fixes, avoid deleting valuable tests, and rerun broader related lanes after shared test infrastructure changes.

For compatibility findings, do not recreate the released implementation in a new fixture. Use the real released artifact/serializer/client or a provenance-pinned golden vector. Exercise every affected reachable old/new direction, but do not generate a full UI × CLI × daemon × server × platform matrix when the candidate did not change the shared seam. Select end-to-end rows from actual rollout/rollback order and risk.

## Required Finish

The validation skill is done only when:
- every required lane in `PLAN.md` is `[x]` or explicitly `[DEFERRED-HUMAN-APPROVED]`
- `TRACKING.md` has no unanswered open questions or unresolved suspected issues
- every QA matrix row is green, fixed-and-rerun-green, or human-approved deferred with release-note text
- every affected required compatibility direction has immutable baseline evidence and a deciding contract/vector or end-to-end result; unreachable/unsupported directions have a recorded rationale
- independent reviewers for daemon ownership, installer/update, session continuity, and final cross-cutting review are GREEN
- final integrated custom checks are green
- local release dry-run is complete and recorded
- the handoff packet says “ready for validation review”, not “released”

## References

- `references/workflow.md`: complete orchestration protocol
- `references/lane-catalog.md`: lanes, checks, commands, and current check inventory
- `references/manual-qa-matrix.md`: Linux/macOS/Windows/manual/mobile QA matrix
- `references/daemon-ownership-scenarios.md`: concrete daemon ownership regression/state matrix for L21
- `references/evidence-contract.md`: what counts as evidence
- `references/prompts.md`: orchestrator, lane, fix-agent, and reviewer prompt shapes

## Composes With

- `happier-testing`: lane semantics, TDD, fixture policy, and anti-flake rules.
- `happier-session-control`: scripted session create/send/wait/status flows in manual QA lanes.
- `happier-implement`: evidence-driven root-cause correction when a code, harness, or product-behavior lane fails.
- `happier-diagnose`: read-only investigation when the failure is specifically a runtime, session, daemon, provider, authentication, or connectivity incident.
- `happier-github-ops`: optional sanitized issue filing for human-approved deferred release blockers.
