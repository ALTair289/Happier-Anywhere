---
name: happier-release-validation
description: Resolve the private Happier release authority for validation work.
metadata: {"openclaw":{"homepage":"https://github.com/happier-dev/happier"}}
---

# Happier Release Validation

Resolve the private release authority before validation work:

```bash
hmaint release bootstrap --repo <absolute checkout> --json
```

Use the returned private skill and its instructions as the authoritative validation procedure. Inspect the public shape with `node scripts/pipeline/run.mjs release-contract`; do not retain a second validation policy here.
