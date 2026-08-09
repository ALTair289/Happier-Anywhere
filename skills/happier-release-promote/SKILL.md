---
name: happier-release-promote
description: Resolve the private Happier release authority for promotion work.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release Promote

Resolve the private release authority before promotion work:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill and its instructions as the authoritative promotion procedure. The public contract is available with `node scripts/pipeline/run.mjs release-contract`; do not recreate private release policy here.
