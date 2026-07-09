---
name: decompose-gates
description: Decompose a hard or multi-part task into independently checkable pieces with explicit verification gates and risk-weighted ordering. Use when planning corridor-sized work, writing lane briefs for subagents or Codex, or whenever a task is too large to verify as a whole.
---

# Decompose With Gates

Turn a hard task into pieces that can each pass or fail on their own, ordered so the riskiest assumption is tested first. Full doctrine: `docs/agent-craft.md` §2–§3.

## Procedure

1. **Split along verification boundaries, not implementation convenience.** Each piece must have its own pass/fail check that does not depend on the other pieces being right. If checking B assumes A is correct, A+B is one piece, not two.
2. **State each piece as a falsifiable claim, not a task.** "The watermark advances only after server ack" (checkable) — not "update watermark logic" (a task). Attach to each claim the concrete check that decides it: a test slice, a log observation, a live replay, a measurement.
3. **Name the risk spots before sequencing.** Write the two or three "if I'm wrong anywhere, it's here" spots — silent failure modes, irreversible steps, boring mechanical stretches — and design a specific verification for each. Generic suite runs are uniform effort against non-uniform risk.
4. **Order by information yield.** Run first the piece whose failure invalidates the rest (e.g. "the event fires before layout"). A ten-minute check beats three days built on a false premise.
5. **Write down inter-piece assumptions.** What each piece assumes from the others is itself a piece to check; most integration failures live at those interfaces, not inside the pieces.
6. **Right-size.** A piece owns a whole responsibility end to end: analysis, change, tests, validation. Too small to fail meaningfully is overhead — micro-slicing (one-boolean extractions) provably grew the god-files it was meant to shrink. Too big to check independently is not decomposed yet.

## When pieces become lane briefs

- One writer per file AND per seam; adjacent-seam work counts as a conflict even across different files. Keep an explicit file-ownership map while lanes run.
- Every brief carries its gate (the falsifiable claim plus its check) and requires incremental landing: lane report and ledger updated after each gate closes, so a crashed lane loses at most one gate.
- Hard gates are measured, not reported: reviewers re-measure (`wc -l` before/after, rerun the suite at the recorded commit). Lanes mis-report; design for it.
- A lane brief should be a sufficient restart brief on its own: if the lane dies, its on-disk report plus the brief must let a fresh agent continue without the lost transcript.
- Schedule the adversarial review with the work, not after it: every brief names how its deliverable gets reviewed — author self-attack at minimum; an independent reviewer (author ≠ reviewer) for corridor gates and ship decisions. See root `AGENTS.md` → "Adversarial review by default".

## Output

A short plan listing: the pieces as claims, each with its deciding check; the named risk spots with their specific verifications; the ordering and why; the inter-piece assumptions.

## Failure this prevents

The monolithic change where something works but you cannot say which part, and something fails but you cannot say where.
