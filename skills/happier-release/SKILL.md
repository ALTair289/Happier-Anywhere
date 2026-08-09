---
name: happier-release
description: Resolve Happier's private release authority from the public repository contract.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release

Inspect the public machine-readable contract with:

```bash
node scripts/pipeline/run.mjs release-contract
```

Then resolve the private release authority for the absolute checkout:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill and its instructions as authoritative. The public contract defines targets, profiles, and compatibility intent; private operating procedure stays outside this repository.
