---
name: attack-conclusion
description: Adversarial self-review of your own conclusion, fix, or root-cause verdict before handoff — alternative causes, neighboring cases, blast radius, environment gap, hypothesis lock, and a scan for fake-competence patterns. Use before closeout of non-trivial changes, root-cause verdicts, or ship decisions; pairs with autoreview.
---

# Attack Your Conclusion

Before handing over a conclusion, switch roles completely: you are no longer the author defending it, you are the reviewer paid to break it, with the same energy spent building it. Full doctrine: `docs/agent-craft.md` §6 and §8.

The test of whether you actually switched roles: did you go looking for evidence that would change your mind, or only re-inspect the evidence that formed the conclusion?

## The standard attacks — in order of cheapness, each as a runnable check

1. **Alternative cause.** What else explains all the same evidence? If you cannot name a second candidate, you have not looked — real evidence almost always underdetermines the cause. Name it, then find the observation that discriminates.
2. **Neighboring cases.** The fix works for the reproduced case. Run the case next door: the empty list, the second invocation, the other platform, the resumed session, the concurrent caller.
3. **Blast radius.** What consumes what you changed? Search callers, readers, subscribers, tests, serialized forms. "Nothing else uses this" is a claim — re-derive it, don't assert it.
4. **Environment gap.** Does the conclusion survive where the code actually runs, or only in the harness? Host tests encode the same assumptions the author had. For user-visible behavior, the live gate (browser/device against the running stack) is the ship gate — see root `AGENTS.md` → Live validation doctrine.
5. **Hypothesis lock.** Are you explaining the evidence, or explaining your first hypothesis? Re-read the raw evidence pretending you just arrived and have no favorite.

Run the cheap attacks; an attack that is just worry is not an attack. If you cannot state what would falsify the conclusion, it is not a conclusion yet — it is a preference.

## Fake-competence scan

Check the deliverable against the patterns that read as skill and aren't (`docs/agent-craft.md` §8). The highest-frequency ones:

- **Thoroughness theater** — exhaustive coverage of what was easy to check, presented as coverage of the risk. Where are the "if I'm wrong, it's here" spots in the report?
- **Green tests as proof** — green means "didn't break what we previously thought to check", not "correct".
- **Defensive over-engineering** — fallbacks for impossible states are unexamined uncertainty made permanent, and future split-brains.
- **Silent recovery** — an error worked around and not mentioned discards the most informative event of the session.
- **Uniform hedging** — everything marked uncertain so nothing can be wrong; commit where the evidence commits.

## Auto mode — the default, not a request

Adversarial review is scheduled with the work, not requested after it (root `AGENTS.md` → "Adversarial review by default"):

- Author self-attack (this skill) before every non-trivial handoff.
- Independent review for delegated lane/corridor deliverables and ship gates: a different session — preferably a different model than the author — runs `skills/verify-claims` on the claims and re-runs these attacks. Author ≠ reviewer; nothing is self-signed.
- The reviewer's brief is to refute, not confirm: attempt the failure the author says cannot happen, and re-measure rather than re-read.

## Output

For each attack: what was run and what it showed, or why it was skipped. A pass that found nothing states what was attacked and how — "no findings" without the attack list is not a review. Any attack that landed goes to the top of the handoff (see `skills/handoff-report`), not the bottom.

## Failure this prevents

Motivated reasoning shipping with a green checkmark on it — the review conducted by the same mind that made the mistake, finding nothing.
