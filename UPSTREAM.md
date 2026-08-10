# Upstream source and synchronization

Happier Anywhere Source is a full-history GitHub fork of Happier. The source
relationship is intentionally explicit:

- downstream fork: https://github.com/ALTair289/Happier-Anywhere-Source
- official upstream: https://github.com/happier-dev/happier
- upstream default branch: `dev`
- initial downstream base: `4b76fc8c60fffeb1c08a26ef05d0ffe22684168e`

The root `LICENCE` is preserved byte-for-byte from upstream. `NOTICE` records
the downstream identity without changing upstream authorship.

## Local remotes

Use `origin` for the downstream fork and `upstream` for the official project:

```text
origin   https://github.com/ALTair289/Happier-Anywhere-Source.git
upstream https://github.com/happier-dev/happier.git
```

Fetch both remotes before preparing a synchronization change:

```bash
git fetch origin --prune
git fetch upstream --prune --tags
git merge-base --is-ancestor origin/dev upstream/dev
```

The last command must succeed before treating `upstream/dev` as a safe
fast-forward source for the fork's `dev` mirror. If it fails, stop and inspect
the divergence; do not resolve it by force-push.

## Synchronization policy

1. Keep `origin/dev` as the reviewable upstream mirror and use GitHub's fork
   synchronization mechanism only when it can fast-forward.
2. Develop downstream changes on `codex/*` branches.
3. Integrate downstream work through protected pull requests. Merge an updated
   `dev` into the downstream integration/release line through a reviewed pull
   request rather than editing upstream refs.
4. Record the new upstream base in `SOURCE_PROVENANCE.json` in the same reviewed
   change that consumes it.
5. Re-run source policy, filename, and redacted secret scans before merge.

Never use `push --mirror`, force-push, rewrite upstream history, delete upstream
tags, or copy local dirty worktrees into this repository. Do not push upstream
branches or tags to `origin` as a substitute for GitHub fork synchronization.
