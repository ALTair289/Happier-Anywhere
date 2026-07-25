---
name: happier-release-promote
description: Promote a Happier release only after validation and human review approval. Runs release dry-run first, requires explicit human approval for external side effects, then executes preview or production promotion through the repo release orchestrator.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release Promote

Use this skill only after `happier-release-validation-review` approves the candidate.

## Mission

Perform the actual release promotion through the canonical repo release orchestrator. This skill has external side effects and must always ask for explicit human approval before the non-dry-run command.

## Required Inputs

- Human approval from validation review
- Target lane: preview or production
- Candidate branch/worktree
- Bump mode
- Deploy targets
- Mobile/desktop action choices, if any

## Process

1. Read `references/promotion-commands.md`.
2. Confirm validation review verdict is `APPROVE_FOR_PREVIEW_PROMOTION` or equivalent production approval.
3. Run dry-run command.
4. Summarize planned side effects.
5. Ask for explicit approval to run the real command.
6. Execute only after approval.
7. Monitor GitHub/release jobs until completion.
8. Verify the post-publish `release-verify.yml` result when the release profile triggers it, or explicitly record why it was skipped.
9. Report published versions/artifacts and any follow-up verification.

Never bypass `node scripts/pipeline/run.mjs release` for full releases unless the user explicitly requests a manual partial publish.

## Target Discipline

Preview and production have different gates. Use this skill with an explicit target:
- `preview`: promote `dev` to `preview` after validation review approval.
- `production`: promote `preview` to `main` only after preview soak and separate production approval.

Deploy webhook calls may require Cloudflare Access service tokens. If required credentials are missing, stop and report the missing secret; do not attempt unauthenticated workarounds.
